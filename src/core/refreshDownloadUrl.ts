import { TaskData } from '../type'
import { PauseState } from './pauseManager'
import { getDownloadUrl } from './bilibili'
const log = require('electron-log')

/**
 * 刷新过期的下载链接
 * @param pauseState 暂停状态数据
 * @returns 新的下载链接
 */
export async function refreshDownloadUrl(pauseState: PauseState): Promise<{ video: string, audio: string }> {
  try {
    log.info(`开始刷新下载链接: ${pauseState.taskId}`)
    
    // 重新获取下载链接
    const { video, audio } = await getDownloadUrl(pauseState.cid, pauseState.bvid, pauseState.quality)
    
    if (!video || !audio) {
      throw new Error('获取新的下载链接失败')
    }
    
    log.info(`下载链接刷新成功: ${pauseState.taskId}`)
    log.info(`新视频链接: ${video.substring(0, 100)}...`)
    log.info(`新音频链接: ${audio.substring(0, 100)}...`)
    
    return { video, audio }
  } catch (error: any) {
    log.error(`刷新下载链接失败: ${pauseState.taskId} - ${error.message}`)
    throw new Error(`刷新下载链接失败: ${error.message}`)
  }
}

/**
 * 更新任务数据的下载链接
 * @param taskData 任务数据
 * @param newUrls 新的下载链接
 * @returns 更新后的任务数据
 */
export function updateTaskDownloadUrls(taskData: TaskData, newUrls: { video: string, audio: string }): TaskData {
  return {
    ...taskData,
    downloadUrl: {
      video: newUrls.video,
      audio: newUrls.audio
    }
  }
}

/**
 * 检查并刷新过期的下载链接
 * @param taskData 任务数据
 * @param pauseState 暂停状态
 * @returns 更新后的任务数据
 */
export async function checkAndRefreshUrls(taskData: TaskData, pauseState: PauseState): Promise<TaskData> {
  try {
    // 检查链接是否过期（暂停时间超过10分钟）
    const now = Date.now()
    const pausedTime = pauseState.pausedAt
    const tenMinutes = 10 * 60 * 1000
    
    if ((now - pausedTime) > tenMinutes) {
      log.info(`检测到链接可能已过期，开始刷新: ${taskData.title}`)
      
      // 刷新链接
      const newUrls = await refreshDownloadUrl(pauseState)
      
      // 更新任务数据
      const updatedTask = updateTaskDownloadUrls(taskData, newUrls)
      
      log.info(`链接刷新完成: ${taskData.title}`)
      return updatedTask
    } else {
      log.info(`链接未过期，无需刷新: ${taskData.title}`)
      return taskData
    }
  } catch (error: any) {
    log.error(`检查和刷新链接失败: ${taskData.title} - ${error.message}`)
    throw error
  }
}
