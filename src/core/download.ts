import fs from 'fs-extra'
import { IpcMainEvent } from 'electron'
import { mergeVideoAudio } from './media'
import { randUserAgent } from '../utils'
import { downloadSubtitle } from './subtitle'
import { TaskData, SettingData } from '../type'
import { downloadDanmaku } from './danmaku'
import store from './mainStore'
import { throttle } from 'lodash'
import { STATUS } from '../assets/data/status'

const log = require('electron-log')
const stream = require('stream')
const { promisify } = require('util')
const got = require('got')
const pipeline = promisify(stream.pipeline)

const downloadControllers: Map<string, AbortController> = new Map()

const downloadProgress: Map<string, { videoBytes: number, audioBytes: number, phase: 'video' | 'audio' }> = new Map()

export function pauseDownload (taskId: string, event: IpcMainEvent): boolean {
  const controller = downloadControllers.get(taskId)
  if (!controller) {
    log.warn(`[pause] 任务 ${taskId} 没有控制器`)
    return false
  }
  const progress = downloadProgress.get(taskId)
  const taskData = store.get(`taskList.${taskId}`)

  if (!taskData) {
    log.error(`[pause] 任务 ${taskId} 不存在`)
    return false
  }
  controller.abort()
  downloadControllers.delete(taskId)

  const updateData = {
    id: taskId,
    status: STATUS.PAUSED,
    downloadedVideoBytes: progress?.videoBytes || 0,
    downloadedAudioBytes: progress?.audioBytes || 0,
    pausedPhase: progress?.phase || 'video'
  }

  event.reply('download-video-status', updateData)
  store.set(`taskList.${taskId}`, { ...taskData, ...updateData })

  log.info(`⏸️ 任务已暂停: ${taskData.title}, 视频: ${updateData.downloadedVideoBytes} bytes, 音频: ${updateData.downloadedAudioBytes} bytes, 阶段: ${updateData.pausedPhase}`)
  return true
}

export function getActiveDownloads (): string[] {
  return Array.from(downloadControllers.keys())
}

export function isDownloading (taskId: string): boolean {
  return downloadControllers.has(taskId)
}

function handleDeleteFile (setting: SettingData, videoInfo: TaskData) {
  // 删除原视频
  if (setting.isDelete) {
    const filePathList = videoInfo.filePathList
    fs.removeSync(filePathList[2])
    fs.removeSync(filePathList[3])
  }
}

async function getVideoSize (pathList: string[]) {
  const [mp4Path, , videoPath, audioPath] = pathList
  try {
    return fs.stat(mp4Path).then(stat => stat.size)
  } catch (error: any) {
    log.error(`[main-get-video-size]: error ${error?.message || 'unknown error'}`)
  }
  // 如获取mp4失败则可能 是设置了不合并视频，则视频大小 = video + audio
  try {
    const plist = [fs.stat(videoPath), fs.stat(audioPath)]
    return Promise.all(plist).then(([videoStat, audioStat]) => videoStat.size + audioStat.size)
  } catch (error) {
    return 0
  }
}

function updateStore (id: string, data: AnyObject) {
  const preTaskData = store.get(`taskList.${id}`)
  // 如果状态不变 那就只可能进度变化，不是很重要的信息 则不更新 electron的store(不是渲染层的store)
  if (preTaskData?.status === data.status) return
  // 失败的状态不再更改
  if (preTaskData?.status === STATUS.FAIL) return
  // console.log('>>>>> ', preTaskData.status, preTaskData?.progress, data.status, data.progress) // 5 0 1 0
  // const isReDownload = preTaskData.status === STATUS.FAIL && data.status === STATUS.VIDEO_DOWNLOADING
  // console.log('isReDownload >>>', isReDownload, preTaskData.status, preTaskData?.progress, data.status, data.progress)
  // 如果出现进度倒退的情况 则抛弃此次 download-video-status, 失败的情况特殊 因为无 progress
  if (
    data.status !== STATUS.FAIL &&
    preTaskData?.status !== STATUS.PAUSED &&
    preTaskData && preTaskData?.progress &&
    preTaskData?.progress > data.progress
    // && !isReDownload
  ) {
    return
  }
  // console.log('[main-update-store]: ', id, data, preTaskData)
  store.set(`taskList.${id}`, Object.assign({}, preTaskData, data))
}


async function downloadWithAbort (
  url: string,
  filePath: string,
  config: any,
  controller: AbortController,
  startBytes: number,
  onProgress: (downloaded: number, total: number) => void
): Promise<{ downloaded: number, aborted: boolean }> {
  return new Promise((resolve, reject) => {
    let downloaded = startBytes
    let totalSize = 0
    let aborted = false
    const headers = { ...config.headers }
    if (startBytes > 0) {
      headers.Range = `bytes=${startBytes}-`
      log.info(`[download] 继续，从 ${startBytes} 开始`)
    }

    const requestConfig = {
      ...config,
      headers
    }

    const writeFlags = startBytes > 0 ? 'a' : 'w'
    const writeStream = fs.createWriteStream(filePath, { flags: writeFlags })
    const downloadStream = got.stream(url, requestConfig)

    const abortHandler = () => {
      aborted = true
      downloadStream.destroy()
      writeStream.end()
      resolve({ downloaded, aborted: true })
    }
    controller.signal.addEventListener('abort', abortHandler, { once: true })
    downloadStream.on('response', (response: any) => {
      const contentRange = response.headers['content-range']
      if (contentRange) {
        const match = contentRange.match(/bytes \d+-\d+\/(\d+)/)
        if (match) {
          totalSize = parseInt(match[1], 10)
        }
      } else {
        totalSize = parseInt(response.headers['content-length'] || '0', 10) + startBytes
      }
    })

    downloadStream.on('data', (chunk: Buffer) => {
      if (aborted) return
      downloaded += chunk.length
      onProgress(downloaded, totalSize)
    })

    downloadStream.on('error', (error: any) => {
      controller.signal.removeEventListener('abort', abortHandler)
      if (aborted || error.code === 'ERR_ABORTED') {
        resolve({ downloaded, aborted: true })
      } else {
        reject(error)
      }
    })

    writeStream.on('error', (error: any) => {
      controller.signal.removeEventListener('abort', abortHandler)
      reject(error)
    })

    writeStream.on('finish', () => {
      controller.signal.removeEventListener('abort', abortHandler)
      if (!aborted) {
        resolve({ downloaded, aborted: false })
      }
    })

    downloadStream.pipe(writeStream)
  })
}

export default async (videoInfo: TaskData, event: IpcMainEvent, setting: SettingData, isResume = false) => {
  const taskId = videoInfo.id
  const controller = new AbortController()
  downloadControllers.set(taskId, controller)
  const startVideoBytes = isResume && videoInfo.pausedPhase === 'audio' ? (videoInfo.downloadedVideoBytes || 0) : (isResume ? (videoInfo.downloadedVideoBytes || 0) : 0)
  const startAudioBytes = isResume ? (videoInfo.downloadedAudioBytes || 0) : 0
  const skipVideo = isResume && videoInfo.pausedPhase === 'audio'

  downloadProgress.set(taskId, {
    videoBytes: startVideoBytes,
    audioBytes: startAudioBytes,
    phase: skipVideo ? 'audio' : 'video'
  })

  if (!isResume) {
    const updateData = {
      id: taskId,
      status: STATUS.VIDEO_DOWNLOADING,
      progress: 0
    }
    event.reply('download-video-status', updateData)
    updateStore(taskId, { ...videoInfo, ...updateData })
  }

  // 去掉扩展名的文件路径
  const fileName = videoInfo.filePathList[0].substring(0, videoInfo.filePathList[0].length - 4)
// if (setting.isFolder) {
  // 创建文件夹 存在多p视频时 设置关闭了 下载到单独的文件时 也会需插件合集的目录
  try {
    if (!fs.existsSync(videoInfo.fileDir)) {
      fs.mkdirSync(`${videoInfo.fileDir}`, { recursive: true })
      log.info(`文件夹创建成功：${videoInfo.fileDir}`)
    }
  } catch (error) {
    log.error(`创建文件夹失败：${error}`)
  }
  // }
  // >>>>>>>>>>>>>>>>>>>>>>>>>>>>>> 下载封面 <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
  if (setting.isCover && !isResume) {
    try {
      const imageConfig = {
        headers: {
          'User-Agent': randUserAgent(),
          cookie: `SESSDATA=${setting.SESSDATA}`
        }
      }
      await pipeline(
        got.stream(videoInfo.cover, imageConfig),
        fs.createWriteStream(videoInfo.filePathList[1])
      )
      log.info(`✅ 下载封面完成 ${videoInfo.title}`)
    } catch (error: any) {
      log.error(`下载封面失败：${error.message}`)
    }
  }

  // 下载字幕 (属于额外的文件无需merge)无需await
  if (setting.isSubtitle && !isResume && Array.isArray(videoInfo.subtitle) && videoInfo.subtitle.length > 0) {
    downloadSubtitle(fileName, videoInfo.subtitle)
    log.info(`✅ 下载字幕完成 ${videoInfo.title}`)
  }

  // >>>>>>>>>>>>>>>>>>>>>>>>>>>>>> 下载弹幕 (属于额外的文件无需merge)无需await <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
  if (setting.isDanmaku && !isResume) {
// event.reply('download-danmuku', videoInfo.cid, videoInfo.title, `${fileName}.ass`)

    downloadDanmaku(videoInfo.cid, videoInfo.title, `${fileName}.ass`)
    log.info(`✅ 下载弹幕完成 ${videoInfo.title}`)
  }

  const downloadConfig = {
    headers: {
      'User-Agent': randUserAgent(),
      referer: videoInfo.url
    },
    cookie: `SESSDATA=${setting.SESSDATA}`
  }
  const throttledVideoProgress = throttle((downloaded: number, total: number) => {
    if (total === 0) return
    const progress = downloadProgress.get(taskId)
    if (progress) progress.videoBytes = downloaded

    const percent = Math.round((downloaded / total) * 100 * 0.74)
    const updateData = {
      id: taskId,
      status: STATUS.VIDEO_DOWNLOADING,
      progress: percent,
      downloadedVideoBytes: downloaded
    }
    event.reply('download-video-status', updateData)
    updateStore(taskId, { ...videoInfo, ...updateData })
  }, 2000)

  const throttledAudioProgress = throttle((downloaded: number, total: number) => {
    if (total === 0) return
    const progress = downloadProgress.get(taskId)
    if (progress) progress.audioBytes = downloaded

    const percent = Math.round((downloaded / total) * 100 * 0.22 + 75)
    const updateData = {
      id: taskId,
      status: STATUS.AUDIO_DOWNLOADING,
      progress: percent,
      downloadedAudioBytes: downloaded
    }
    event.reply('download-video-status', updateData)
    updateStore(taskId, { ...videoInfo, ...updateData })
  }, 2000)

  try {
    // >>>>>>>>>>>>>>>>>>>>>>>>>>>>>> 下载视频 <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
    if (!skipVideo) {
      log.info(`开始下载视频: ${videoInfo.downloadUrl.video}, 从 ${startVideoBytes} bytes 开始`)

      const updateData = {
        id: taskId,
        status: STATUS.VIDEO_DOWNLOADING,
        progress: startVideoBytes > 0 ? Math.round(0.74 * 50) : 0 // 续传时给个估计进度
      }
      event.reply('download-video-status', updateData)

      const videoResult = await downloadWithAbort(
        videoInfo.downloadUrl.video,
        videoInfo.filePathList[2],
        downloadConfig,
        controller,
        startVideoBytes,
        throttledVideoProgress
      )

      if (videoResult.aborted) {
        log.info(`视频下载已暂停: ${videoInfo.title}`)
        downloadProgress.delete(taskId)
        return
      }

      log.info(`✅ 下载视频完成 ${videoInfo.title}`)
    }

    // 更新阶段
    const progress = downloadProgress.get(taskId)
    if (progress) progress.phase = 'audio'

    // >>>>>>>>>>>>>>>>>>>>>>>>>>>>>> 下载音频 <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
    log.info(`开始下载音频: ${videoInfo.downloadUrl.audio}, 从 ${startAudioBytes} bytes 开始`)

    const audioUpdateData = {
      id: taskId,
      status: STATUS.AUDIO_DOWNLOADING,
      progress: 75
    }
    event.reply('download-video-status', audioUpdateData)

    const audioResult = await downloadWithAbort(
      videoInfo.downloadUrl.audio,
      videoInfo.filePathList[3],
      downloadConfig,
      controller,
      startAudioBytes,
      throttledAudioProgress
    )

    if (audioResult.aborted) {
      log.info(`音频下载已暂停: ${videoInfo.title}`)
      downloadProgress.delete(taskId)
      return
    }

    log.info(`✅ 下载音频完成 ${videoInfo.title}`)

    // 清理控制器和进度
    downloadControllers.delete(taskId)
    downloadProgress.delete(taskId)

    // >>>>>>>>>>>>>>>>>>>>>>>>>>>>>> 合成视频 <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
    if (setting.isMerge) {
      const mergeData = {
        id: taskId,
        status: STATUS.MERGING,
        progress: 98
      }
      event.reply('download-video-status', mergeData)
      updateStore(taskId, { ...videoInfo, ...mergeData })

      try {
        const res = await mergeVideoAudio(
          videoInfo.filePathList[2],
          videoInfo.filePathList[3],
          videoInfo.filePathList[0]
        )
        log.info(`✅ 音视频合成成功：${videoInfo.title} ${res}`)

        const completeData: AnyObject = {
          id: taskId,
          status: STATUS.COMPLETED,
          progress: 100,
          size: -1,
          downloadedVideoBytes: undefined,
          downloadedAudioBytes: undefined,
          pausedPhase: undefined
        }

        if (Array.isArray(videoInfo.filePathList)) {
          completeData.size = await getVideoSize(videoInfo.filePathList)
        }

        event.reply('download-video-status', completeData)
        updateStore(taskId, { ...videoInfo, ...completeData })
      } catch (error: any) {
        log.error(`音视频合成失败：${videoInfo.title} ${error.message}`)
        const failData = { id: taskId, status: STATUS.FAIL }
        event.reply('download-video-status', failData)
        updateStore(taskId, { ...videoInfo, ...failData })
      } finally {
        handleDeleteFile(setting, videoInfo)
      }
    } else {
      const completeData = {
        id: taskId,
        status: STATUS.COMPLETED,
        progress: 100,
        downloadedVideoBytes: undefined,
        downloadedAudioBytes: undefined,
        pausedPhase: undefined
      }
      event.reply('download-video-status', completeData)
      updateStore(taskId, { ...videoInfo, ...completeData })
      handleDeleteFile(setting, videoInfo)
    }
  } catch (error: any) {
    log.error(`下载失败：${videoInfo.title} - ${error.message}`)
    downloadControllers.delete(taskId)
    downloadProgress.delete(taskId)

    const failData = { id: taskId, status: STATUS.FAIL }
    event.reply('download-video-status', failData)
    updateStore(taskId, { ...videoInfo, ...failData })
  }
}
