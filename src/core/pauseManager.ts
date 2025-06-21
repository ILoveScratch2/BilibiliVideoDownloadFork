import { TaskData } from '../type'
import { STATUS } from '../assets/data/status'
const fs = require('fs-extra')
const path = require('path')
const log = require('electron-log')

// 暂停状态数据接口
export interface PauseState {
  taskId: string
  originalUrl: string // 原始视频链接（非下载链接）
  bvid: string
  cid: number
  quality: number
  videoProgress: number // 视频下载进度 (0-1)
  audioProgress: number // 音频下载进度 (0-1)
  downloadPhase: 'video' | 'audio' | 'merge' // 当前下载阶段
  pausedAt: number // 暂停时间戳
  videoDownloadedBytes?: number // 视频已下载字节数
  audioDownloadedBytes?: number // 音频已下载字节数
  videoTotalBytes?: number // 视频总字节数
  audioTotalBytes?: number // 音频总字节数
  filePathList: string[] // 文件路径列表
}

// 全局暂停状态管理
const pausedTasks = new Map<string, PauseState>()

/**
 * 获取暂停状态文件路径
 */
function getPauseStateFilePath(taskId: string, fileDir: string): string {
  return path.join(fileDir, `.pause_${taskId}.json`)
}

/**
 * 保存暂停状态到文件
 */
export async function savePauseState(taskData: TaskData, pauseState: PauseState): Promise<void> {
  try {
    const filePath = getPauseStateFilePath(taskData.id, taskData.fileDir)
    
    // 确保目录存在
    await fs.ensureDir(taskData.fileDir)
    
    // 保存到文件
    await fs.writeJson(filePath, pauseState, { spaces: 2 })
    
    // 同时保存到内存
    pausedTasks.set(taskData.id, pauseState)
    
    log.info(`暂停状态已保存: ${taskData.title} -> ${filePath}`)
  } catch (error: any) {
    log.error(`保存暂停状态失败: ${taskData.title} - ${error.message}`)
    throw error
  }
}

/**
 * 从文件加载暂停状态
 */
export async function loadPauseState(taskId: string, fileDir: string): Promise<PauseState | null> {
  try {
    const filePath = getPauseStateFilePath(taskId, fileDir)
    
    if (!await fs.pathExists(filePath)) {
      return null
    }
    
    const pauseState = await fs.readJson(filePath)
    
    // 验证暂停状态数据完整性
    if (!pauseState.taskId || !pauseState.originalUrl || !pauseState.bvid) {
      log.warn(`暂停状态文件数据不完整: ${filePath}`)
      return null
    }
    
    // 加载到内存
    pausedTasks.set(taskId, pauseState)
    
    log.info(`暂停状态已加载: ${taskId} -> ${filePath}`)
    return pauseState
  } catch (error: any) {
    log.error(`加载暂停状态失败: ${taskId} - ${error.message}`)
    return null
  }
}

/**
 * 删除暂停状态文件
 */
export async function deletePauseState(taskId: string, fileDir: string): Promise<void> {
  try {
    const filePath = getPauseStateFilePath(taskId, fileDir)
    
    if (await fs.pathExists(filePath)) {
      await fs.remove(filePath)
      log.info(`暂停状态文件已删除: ${filePath}`)
    }
    
    // 从内存中移除
    pausedTasks.delete(taskId)
  } catch (error: any) {
    log.error(`删除暂停状态文件失败: ${taskId} - ${error.message}`)
  }
}

/**
 * 检查任务是否处于暂停状态
 */
export function isPaused(taskId: string): boolean {
  return pausedTasks.has(taskId)
}

/**
 * 获取内存中的暂停状态
 */
export function getPauseState(taskId: string): PauseState | null {
  return pausedTasks.get(taskId) || null
}

/**
 * 设置任务为暂停状态（仅内存）
 */
export function setPaused(taskId: string, pauseState: PauseState): void {
  pausedTasks.set(taskId, pauseState)
}

/**
 * 移除任务的暂停状态（仅内存）
 */
export function removePaused(taskId: string): void {
  pausedTasks.delete(taskId)
}

/**
 * 创建暂停状态对象
 */
export function createPauseState(
  taskData: TaskData,
  downloadPhase: 'video' | 'audio' | 'merge',
  videoProgress: number = 0,
  audioProgress: number = 0,
  videoDownloadedBytes?: number,
  audioDownloadedBytes?: number,
  videoTotalBytes?: number,
  audioTotalBytes?: number
): PauseState {
  return {
    taskId: taskData.id,
    originalUrl: taskData.url,
    bvid: taskData.bvid,
    cid: taskData.cid,
    quality: taskData.quality,
    videoProgress,
    audioProgress,
    downloadPhase,
    pausedAt: Date.now(),
    videoDownloadedBytes,
    audioDownloadedBytes,
    videoTotalBytes,
    audioTotalBytes,
    filePathList: taskData.filePathList
  }
}

/**
 * 检查暂停状态是否过期（超过10分钟需要刷新链接）
 */
export function isPauseStateExpired(pauseState: PauseState): boolean {
  const now = Date.now()
  const pausedTime = pauseState.pausedAt
  const tenMinutes = 10 * 60 * 1000 // 10分钟
  
  return (now - pausedTime) > tenMinutes
}

/**
 * 获取所有暂停的任务ID
 */
export function getAllPausedTaskIds(): string[] {
  return Array.from(pausedTasks.keys())
}

/**
 * 清理所有暂停状态（应用启动时调用）
 */
export function clearAllPauseStates(): void {
  pausedTasks.clear()
  log.info('所有暂停状态已清理')
}
