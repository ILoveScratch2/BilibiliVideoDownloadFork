import { IpcMainEvent } from 'electron'
import { mergeVideoAudio } from './media'
import { randUserAgent, sleep } from '../utils'
import { downloadSubtitle } from './subtitle'
import { TaskData, SettingData } from '../type'
import store from './mainStore'
import { throttle } from 'lodash'
import { STATUS } from '../assets/data/status'
import {
  savePauseState,
  deletePauseState,
  isPaused,
  createPauseState,
  loadPauseState,
  setPaused,
  removePaused,
  PauseState
} from './pauseManager'
import { checkAndRefreshUrls } from './refreshDownloadUrl'

const log = require('electron-log')
const stream = require('stream')
const { promisify } = require('util')
const fs = require('fs-extra')
const got = require('got')
const pipeline = promisify(stream.pipeline)

// 全局下载控制器映射
const downloadControllers = new Map<string, { abort: () => void }>()

// 暂停检查函数
function checkPauseStatus(taskId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const checkInterval = setInterval(() => {
      if (isPaused(taskId)) {
        clearInterval(checkInterval)
        reject(new Error('DOWNLOAD_PAUSED'))
      }
    }, 100) // 每100ms检查一次暂停状态

    // 设置一个超时，避免无限等待
    setTimeout(() => {
      clearInterval(checkInterval)
      resolve()
    }, 1000) // 1秒后自动继续
  })
}

function handleDeleteFile (setting: SettingData, videoInfo: TaskData) {
  // 删除原视频
  if (setting.isDelete) {
    const filePathList = videoInfo.filePathList
    fs.removeSync(filePathList[2])
    fs.removeSync(filePathList[3])
  }
}

export default async (videoInfo: TaskData, event: IpcMainEvent, setting: SettingData, isResume?: boolean) => {
  if (isResume === undefined) {
    isResume = false
  }
  log.info(videoInfo.id, videoInfo.title)
  const takeInfo = store.get(`taskList.${videoInfo.id}`)
  log.info('mainStore', takeInfo, takeInfo && takeInfo.status)

  // 检查是否是恢复下载
  let pauseState: PauseState | null = null
  let updatedVideoInfo = videoInfo

  if (isResume) {
    // 加载暂停状态
    pauseState = await loadPauseState(videoInfo.id, videoInfo.fileDir)
    if (pauseState) {
      log.info(`恢复下载: ${videoInfo.title}`)
      // 检查并刷新过期的下载链接
      try {
        updatedVideoInfo = await checkAndRefreshUrls(videoInfo, pauseState)
      } catch (error: any) {
        log.error(`刷新下载链接失败: ${error.message}`)
        const updateData = {
          id: videoInfo.id,
          status: STATUS.FAIL
        }
        event.reply('download-video-status', updateData)
        store.set(`taskList.${videoInfo.id}`, Object.assign(videoInfo, updateData))
        return
      }
    } else {
      log.warn(`未找到暂停状态，将重新开始下载: ${videoInfo.title}`)
    }
  }

  // 确定开始阶段和进度
  let startPhase: 'video' | 'audio' | 'merge' = 'video'
  let initialProgress = 0
  let videoStartByte = 0
  let audioStartByte = 0

  if (pauseState) {
    startPhase = pauseState.downloadPhase
    if (startPhase === 'video') {
      initialProgress = Math.round(pauseState.videoProgress * 75)
      videoStartByte = pauseState.videoDownloadedBytes || 0
    } else if (startPhase === 'audio') {
      initialProgress = 75 + Math.round(pauseState.audioProgress * 22)
      audioStartByte = pauseState.audioDownloadedBytes || 0
    } else {
      initialProgress = 97
    }
  }

  const updateData = {
    id: updatedVideoInfo.id,
    status: startPhase === 'video' ? STATUS.VIDEO_DOWNLOADING :
            startPhase === 'audio' ? STATUS.AUDIO_DOWNLOADING : STATUS.MERGING,
    progress: initialProgress
  }
  event.reply('download-video-status', updateData)
  store.set(`taskList.${updatedVideoInfo.id}`, {
    ...updatedVideoInfo,
    ...updateData
  })

  // 去掉扩展名的文件路径
  const fileName = videoInfo.filePathList[0].substring(0, videoInfo.filePathList[0].length - 4)
  // if (setting.isFolder) {
  // 创建文件夹 存在多p视频时 设置关闭了 下载到单独的文件时 也会需插件合集的目录
  try {
    if (!fs.existsSync(videoInfo.fileDir)) {
      fs.mkdirSync(`${videoInfo.fileDir}`, {
        recursive: true
      })
      log.info(`文件夹创建成功：${videoInfo.fileDir}`)
    } else {
      log.info(`文件夹已存在：${videoInfo.fileDir}`)
    }
  } catch (error) {
    log.error(`创建文件夹失败：${error}`)
  }
  // }
  // 下载封面
  if (setting.isCover) {
    const imageConfig = {
      headers: {
        'User-Agent': randUserAgent(),
        cookie: `SESSDATA=${setting.SESSDATA}`
      }
    }
    await pipeline(
      got.stream(videoInfo.cover, imageConfig)
        .on('error', (error: any) => {
          console.log(error)
        }),
      fs.createWriteStream(videoInfo.filePathList[1])
    )
    log.info(`✅ 下载封面完成 ${videoInfo.title}`)
  }

  log.info(`下载字幕 "${JSON.stringify(videoInfo.subtitle)}"`)
  // 下载字幕
  if (setting.isSubtitle &&
    Array.isArray(videoInfo.subtitle) &&
    videoInfo.subtitle.length > 0) {
    downloadSubtitle(fileName, videoInfo.subtitle)
    log.info(`✅ 下载字幕完成 ${videoInfo.title}`)
  }

  // 下载弹幕
  if (setting.isDanmaku) {
    event.reply('download-danmuku', videoInfo.cid, videoInfo.title, `${fileName}.ass`)
  }

  // 跳过视频下载阶段（如果从音频阶段恢复）
  if (startPhase !== 'video') {
    log.info(`跳过视频下载阶段: ${updatedVideoInfo.title}`)
  } else {
    const downloadConfig: any = {
      headers: {
        'User-Agent': randUserAgent(),
        referer: updatedVideoInfo.url
      },
      cookie: `SESSDATA=${setting.SESSDATA}`
    }

    if (videoStartByte > 0) {
      downloadConfig.headers.Range = `bytes=${videoStartByte}-`
    }

    let currentVideoProgress = pauseState?.videoProgress || 0
    let videoDownloadedBytes = videoStartByte
    let videoTotalBytes = 0

    const videoProgressNotify = (progress: any) => {
      // 检查暂停状态
      if (isPaused(updatedVideoInfo.id)) {
        return
      }

      videoTotalBytes = progress.total || 0
      videoDownloadedBytes = videoStartByte + (progress.transferred || 0)
      currentVideoProgress = videoTotalBytes > 0 ? videoDownloadedBytes / videoTotalBytes : 0

      const updateData = {
        id: updatedVideoInfo.id,
        status: STATUS.VIDEO_DOWNLOADING,
        progress: Math.round(currentVideoProgress * 75)
      }
      event.reply('download-video-status', updateData)
      store.set(`taskList.${updatedVideoInfo.id}`, Object.assign(updatedVideoInfo, updateData))
    }

    try {
      // 创建下载控制器
      const downloadStream = got.stream(updatedVideoInfo.downloadUrl.video, downloadConfig)
      const abortController = { abort: () => downloadStream.destroy() }
      downloadControllers.set(updatedVideoInfo.id, abortController)

      // 下载视频
      await pipeline(
        downloadStream
          .on('downloadProgress', throttle(videoProgressNotify, 1000))
          .on('error', async (error: any) => {
            if (error.message === 'DOWNLOAD_PAUSED' || isPaused(updatedVideoInfo.id)) {
              // 保存暂停状态
              const pauseState = createPauseState(
                updatedVideoInfo,
                'video',
                currentVideoProgress,
                0,
                videoDownloadedBytes,
                0,
                videoTotalBytes,
                0
              )
              await savePauseState(updatedVideoInfo, pauseState)

              const updateData = {
                id: updatedVideoInfo.id,
                status: STATUS.PAUSED
              }
              event.reply('download-video-status', updateData)
              store.set(`taskList.${updatedVideoInfo.id}`, Object.assign(updatedVideoInfo, updateData))
              return
            }

            log.error(`视频下载失败：${updatedVideoInfo.title}--${error.message}`)
            log.error(`------${updatedVideoInfo.downloadUrl.video}, ${JSON.stringify(downloadConfig)}`)
            const updateData = {
              id: updatedVideoInfo.id,
              status: STATUS.FAIL
            }
            store.set(`taskList.${updatedVideoInfo.id}`, Object.assign(updatedVideoInfo, updateData))
            await sleep(500)
            event.reply('download-video-status', updateData)
          }),
        fs.createWriteStream(updatedVideoInfo.filePathList[2], { flags: videoStartByte > 0 ? 'a' : 'w' })
      )

      // 移除下载控制器
      downloadControllers.delete(updatedVideoInfo.id)

      // 检查是否被暂停
      if (isPaused(updatedVideoInfo.id)) {
        return
      }

    } catch (error: any) {
      if (error.message === 'DOWNLOAD_PAUSED' || isPaused(updatedVideoInfo.id)) {
        return
      }
      throw error
    }
  }

  if (startPhase === 'video') {
    log.info(`✅ 下载视频完成 ${updatedVideoInfo.title}`)
  }

  await sleep(1000)

  // 跳过音频下载阶段（如果从合并阶段恢复）
  if (startPhase === 'merge') {
    log.info(`跳过音频下载阶段: ${updatedVideoInfo.title}`)
  } else {
    const audioDownloadConfig: any = {
      headers: {
        'User-Agent': randUserAgent(),
        referer: updatedVideoInfo.url
      },
      cookie: `SESSDATA=${setting.SESSDATA}`
    }

    if (audioStartByte > 0) {
      audioDownloadConfig.headers.Range = `bytes=${audioStartByte}-`
    }

    let currentAudioProgress = pauseState?.audioProgress || 0
    let audioDownloadedBytes = audioStartByte
    let audioTotalBytes = 0

    const audioProgressNotify = (progress: any) => {
      // 检查暂停状态
      if (isPaused(updatedVideoInfo.id)) {
        return
      }

      audioTotalBytes = progress.total || 0
      audioDownloadedBytes = audioStartByte + (progress.transferred || 0)
      currentAudioProgress = audioTotalBytes > 0 ? audioDownloadedBytes / audioTotalBytes : 0

      const updateData = {
        id: updatedVideoInfo.id,
        status: STATUS.AUDIO_DOWNLOADING,
        progress: Math.round((currentAudioProgress * 22) + 75)
      }
      event.reply('download-video-status', updateData)
      store.set(`taskList.${updatedVideoInfo.id}`, Object.assign(updatedVideoInfo, updateData))
    }

    try {
      // 创建下载控制器
      const downloadStream = got.stream(updatedVideoInfo.downloadUrl.audio, audioDownloadConfig)
      const abortController = { abort: () => downloadStream.destroy() }
      downloadControllers.set(updatedVideoInfo.id, abortController)

      // 下载音频
      await pipeline(
        downloadStream
          .on('downloadProgress', throttle(audioProgressNotify, 1000))
          .on('error', async (error: any) => {
            if (error.message === 'DOWNLOAD_PAUSED' || isPaused(updatedVideoInfo.id)) {
              // 保存暂停状态
              const pauseState = createPauseState(
                updatedVideoInfo,
                'audio',
                1, // 视频已完成
                currentAudioProgress,
                0, // 视频字节数不重要了
                audioDownloadedBytes,
                0,
                audioTotalBytes
              )
              await savePauseState(updatedVideoInfo, pauseState)

              const updateData = {
                id: updatedVideoInfo.id,
                status: STATUS.PAUSED
              }
              event.reply('download-video-status', updateData)
              store.set(`taskList.${updatedVideoInfo.id}`, Object.assign(updatedVideoInfo, updateData))
              return
            }

            log.error(`音频下载失败：${updatedVideoInfo.title} ${error.message}`)
            const updateData = {
              id: updatedVideoInfo.id,
              status: STATUS.FAIL
            }
            store.set(`taskList.${updatedVideoInfo.id}`, Object.assign(updatedVideoInfo, updateData))
            await sleep(500)
            event.reply('download-video-status', updateData)
          }),
        fs.createWriteStream(updatedVideoInfo.filePathList[3], { flags: audioStartByte > 0 ? 'a' : 'w' })
      )

      // 移除下载控制器
      downloadControllers.delete(updatedVideoInfo.id)

      // 检查是否被暂停
      if (isPaused(updatedVideoInfo.id)) {
        return
      }

    } catch (error: any) {
      if (error.message === 'DOWNLOAD_PAUSED' || isPaused(updatedVideoInfo.id)) {
        return
      }
      throw error
    }

    log.info(`✅ 下载音频完成 ${updatedVideoInfo.title}`)
  }

  await sleep(1000)

  // 检查是否被暂停
  if (isPaused(updatedVideoInfo.id)) {
    return
  }

  // 合成视频
  if (setting.isMerge) {
    const updateData = {
      id: updatedVideoInfo.id,
      status: STATUS.MERGING,
      progress: 98
    }
    event.reply('download-video-status', updateData)
    store.set(`taskList.${updatedVideoInfo.id}`, {
      ...updatedVideoInfo,
      ...updateData
    })

    try {
      // 检查是否被暂停
      if (isPaused(updatedVideoInfo.id)) {
        // 保存暂停状态
        const pauseState = createPauseState(
          updatedVideoInfo,
          'merge',
          1, // 视频已完成
          1, // 音频已完成
        )
        await savePauseState(updatedVideoInfo, pauseState)

        const updateData = {
          id: updatedVideoInfo.id,
          status: STATUS.PAUSED
        }
        event.reply('download-video-status', updateData)
        store.set(`taskList.${updatedVideoInfo.id}`, Object.assign(updatedVideoInfo, updateData))
        return
      }

      const res = await mergeVideoAudio(
        updatedVideoInfo.filePathList[2],
        updatedVideoInfo.filePathList[3],
        updatedVideoInfo.filePathList[0]
      )
      log.info(`✅ 音视频合成成功：${updatedVideoInfo.title} ${res}`)

      // 删除暂停状态文件（如果存在）
      await deletePauseState(updatedVideoInfo.id, updatedVideoInfo.fileDir)

      const updateData = {
        id: updatedVideoInfo.id,
        status: STATUS.COMPLETED,
        progress: 100
      }
      event.reply('download-video-status', updateData)
      store.set(`taskList.${updatedVideoInfo.id}`, {
        ...updatedVideoInfo,
        ...updateData
      })
    } catch (error: any) {
      log.error(`音视频合成失败：${updatedVideoInfo.title} ${error.message}`)
      const updateData = {
        id: updatedVideoInfo.id,
        status: STATUS.FAIL
      }
      event.reply('download-video-status', updateData)
      store.set(`taskList.${updatedVideoInfo.id}`, {
        ...updatedVideoInfo,
        ...updateData
      })
    } finally {
      // 删除原视频
      handleDeleteFile(setting, updatedVideoInfo)
    }
  } else {
    // 删除暂停状态文件（如果存在）
    await deletePauseState(updatedVideoInfo.id, updatedVideoInfo.fileDir)

    const updateData = {
      id: updatedVideoInfo.id,
      status: STATUS.COMPLETED,
      progress: 100
    }
    event.reply('download-video-status', updateData)
    store.set(`taskList.${updatedVideoInfo.id}`, {
      ...updatedVideoInfo,
      ...updateData
    })
    handleDeleteFile(setting, updatedVideoInfo)
  }
}

/**
 * 暂停下载
 */
export async function pauseDownload(taskId: string): Promise<void> {
  log.info(`暂停下载: ${taskId}`)

  // 设置暂停标志
  const pauseState = createPauseState(
    { id: taskId } as TaskData,
    'video', // 默认阶段，实际会在下载过程中更新
    0,
    0
  )

  // 先设置暂停状态到内存
  setPaused(taskId, pauseState)

  // 中止下载流
  const controller = downloadControllers.get(taskId)
  if (controller) {
    controller.abort()
    downloadControllers.delete(taskId)
  }
}

/**
 * 继续下载
 */
export async function resumeDownload(taskData: TaskData, event: IpcMainEvent, setting: SettingData): Promise<void> {
  log.info(`继续下载: ${taskData.title}`)

  // 移除暂停状态
  removePaused(taskData.id)

  // 重新开始下载（带恢复标志）
  const downloadFunction = (await import('./download')).default
  return await downloadFunction(taskData, event, setting, true)
}
