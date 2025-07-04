<template>
  <div :class="['container fr', !taskList || !taskList.size ? 'ac jc' : 'bg-fff']">
    <a-empty v-if="!taskList || !taskList.size" :image="require('../assets/images/no-data.png')">
      <template #description>
        <span class="text-active" style="font-weight: bold">暂无数据</span>
      </template>
    </a-empty>
    <template v-else>
      <div class="left custom-scroll-bar" ref="left">
        <div
          v-for="[key, value] in taskList" :key="key"
          :class="['fr', 'download-item',Number(value.status)===STATUS.FAIL && 'error-bg', selected.includes(key) ? 'active' : '']"
          @click.left.exact="switchItem(key)"
          @click.ctrl.exact="multiSelect(key)"
          @click.meta.exact="multiSelect(key)"
          @click.shift.exact="rangeSelect(key)"
          @click.right="showContextmenu(key)">
          <div class="img fr ac">
            <img :src="value.cover" :alt="value.title">
          </div>
          <div class="content fc jsb">
            <div class="ellipsis-1">{{ value.title }}</div>
            <div>状态：<span :class="['text-active', Number(value.status)===STATUS.FAIL && 'error']">{{ formatDownloadStatus(value.status, 'label') }}</span></div>
            <div class="fx">
              <div class="process-bar">
                <a-progress
                  :percent="value.progress"
                  :status="formatDownloadStatus(value.status, 'value')"
                  :strokeColor="Number(value.status)===STATUS.FAIL ? '#ff0000' :'#fb7299'" />
              </div>
              <div class="reload" v-if="Number(value.status)===STATUS.FAIL" @click="reloadBtnClick(key)">
                <ReloadOutlined />
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="right">
        <div class="image">
          <a-image :src="rightTask.cover" :alt="rightTask.title" />
        </div>
        <div class="pl16 mt8 text-active" @click="openBrowser(rightTask.url)">{{ rightTask.title }}</div>
        <div class="fr ac pl16 mt8 up-list">
          UP：<div v-for="(item, index) in rightTask.up" :key="index" class="mr16">
            <a class="ellipsis-1 up-name" @click="openBrowser(`https://space.bilibili.com/${item.mid}`)">{{ item.name }}</a>
          </div>
        </div>
        <div class="mt8 pl16">创建时间：<span class="text-active">{{ dayjs(rightTask.createdTime).format('YYYY-MM-DD HH:mm:ss') }}</span></div>
        <div class="mt8 pl16">视频大小：<span class="text-active">{{ formatVideoSize(rightTask.size) }}</span></div>
        <div class="mt8 pl16">视频时长：<span class="text-active">{{ rightTask.duration }}</span></div>
        <div class="mt8 pl16">清晰度：<span class="text-active">{{ formatQuality(rightTask.quality) }}</span></div>
        <div class="mt8 pl16">播放：<span class="text-active">{{ rightTask.view }}</span></div>
        <div class="mt8 pl16">弹幕：<span class="text-active">{{ rightTask.danmaku }}</span></div>
        <div class="mt8 pl16">评论：<span class="text-active">{{ rightTask.reply }}</span></div>
      </div>
      <div class="clean-btn" @click="cleanAllCompleted">
        <ClearOutlined />
      </div>
    </template>
  </div>
</template>

<script lang="ts" setup>
import { ref, onMounted, toRaw } from 'vue'
import { message, Modal } from 'ant-design-vue'
import dayjs from 'dayjs'
import { downloadStatusMap, STATUS } from '../assets/data/status'
import { storeToRefs } from 'pinia'
import { store } from '../store'
import { qualityMap } from '../assets/data/quality'
import { checkUrl, checkUrlRedirect, parseHtml, getDownloadList, addDownload } from '../core/bilibili'
import { ReloadOutlined, ClearOutlined } from '@ant-design/icons-vue'

const { taskList, rightTask, taskListArray, rightTaskId } = storeToRefs(store.taskStore())
const selected = ref<string[]>([])
const left = ref<any>(null)

const openBrowser = (url: string) => {
  window.electron.openBrowser(url)
}

const formatDownloadStatus = (status: number, type: string) => {
  return downloadStatusMap[status][type]
}

const formatQuality = (quality: number) => {
  return quality === -1 ? '' : qualityMap[quality]
}

const formatVideoSize = (size: number) => {
  return size === -1 ? '' : `${(size / 1000 / 1000).toFixed(2)}MB`
}

const switchItem = (key: string) => {
  selected.value = [key]
  store.taskStore().setRightTaskId(key)
}

const multiSelect = (key: string) => {
  console.log('multiSelect', key)
  const index = selected.value.indexOf(key)
  if (index !== -1) {
    if (selected.value.length > 1) selected.value.splice(index, 1)
  } else {
    selected.value.push(key)
  }
}

const rangeSelect = (key: string) => {
  let start = taskListArray.value.findIndex(item => item[0] === selected.value[0])
  let end = taskListArray.value.findIndex(item => item[0] === key)
  let cancel = null
  if (start > end) {
    cancel = end
    end = start
    start = cancel
  }
  selected.value = []
  for (let idx = start; idx <= end; idx++) {
    selected.value.push(taskListArray.value[idx][0])
  }
}

const showContextmenu = async (key: string) => {
  const isSelectKey = selected.value.includes(key)
  if (!isSelectKey) {
    switchItem(key)
  }

  // 获取当前任务状态
  const currentTask = taskList.value.get(key)
  const taskStatus = currentTask?.status

  let res = ''
  try {
    res = await window.electron.showContextmenu('download', taskStatus)
  } catch (e) {
    console.log(e)
  }
  console.log(res)
  if (res === 'open') {
    openDir()
  } else if (res === 'delete') {
    deleteVideos()
  } else if (res === 'selectAll') {
    selectAll()
  } else if (res === 'reload') {
    reloadDownload()
  } else if (res === 'play') {
    playVideo()
  } else if (res === 'pauseResume') {
    handlePauseResume()
  }
}

const playVideo = () => {
  if (rightTask.value.status === STATUS.COMPLETED) {
    window.electron.openPath(rightTask.value.filePathList[0])
  }
}

const reloadDownload = async () => {
  console.log('重新下载')
  const { response } = await window.electron.openReloadVideoDialog(selected.value.length)
  // 点击取消
  if (!response) return
  // 获取选中任务数据
  const loading = message.loading('下载中...', 0)
  let selectedTask: any[] = []
  selected.value.forEach(item => {
    const task = store.taskStore().getTask(item)
    if (task) selectedTask.push(JSON.parse(JSON.stringify(task)))
  })
  selectedTask = selectedTask.map(item => ({
    ...item,
    curPage: item.page.find((it: any) => it.cid === item.cid) ? item.page.find((it: any) => it.cid === item.cid).page : 0
  }))
  try {
    for (const key in selectedTask) {
      const item = selectedTask[key]
      if (!item.curPage) continue
      const videoType = checkUrl(item.url)
      const { body, url } = await checkUrlRedirect(item.url)
      const videoInfo = await parseHtml(body, videoType, url)
      if (videoInfo === -1) continue
      // 当前list只会存在一项
      const list = await getDownloadList(videoInfo, [item.curPage], item.quality, true, item)
      const taskList = addDownload(list)
      store.taskStore().setTask(taskList)
      // 可以下载
      if (taskList[0].status === STATUS.PLAN_START) {
        window.electron.downloadVideo(taskList[0])
        store.baseStore().addDownloadingTaskCount(1)
      }
      // await sleep(300)
    }
  } catch (e: any) {
    message.error(e.toString())
  }

  loading()
}

const handlePauseResume = () => {
  if (!rightTask.value || !rightTask.value.id) {
    message.error('请选择一个任务')
    return
  }

  const task = rightTask.value
  const isDownloading = [STATUS.VIDEO_DOWNLOADING, STATUS.AUDIO_DOWNLOADING, STATUS.MERGING].includes(task.status)
  const isPaused = task.status === STATUS.PAUSED

  if (isDownloading) {
    // 暂停下载
    window.electron.pauseDownload(task.id)
    message.info(`已暂停下载: ${task.title}`)
  } else if (isPaused) {
    // 继续下载
    window.electron.resumeDownload(task)
    message.info(`已继续下载: ${task.title}`)
    store.baseStore().addDownloadingTaskCount(1)
  } else {
    message.warning('当前任务状态不支持暂停/继续操作')
  }
}

const openDir = () => {
  window.electron.openDir(toRaw(selected.value))
}

const deleteVideos = async () => {
  const { response, checkboxChecked } = await window.electron.openDeleteVideoDialog(selected.value.length)
  console.log(response, checkboxChecked)
  const filelist: string[] = []
  selected.value.forEach(item => {
    const task = store.taskStore().getTask(item)
    if (task && task.filePathList) {
      if (task.filePathList[4]) {
        filelist.push(task.filePathList[4])
      } else {
        filelist.push(task.filePathList[0], task.filePathList[1], task.filePathList[2], task.filePathList[3])
      }
    }
  })
  // 点击取消
  if (!response) return
  // 删除记录
  store.taskStore().deleteTask(toRaw(selected.value))
  // 删除文件
  if (checkboxChecked) window.electron.deleteVideos(filelist)
  message.success('任务已删除')
  if (taskListArray.value && taskListArray.value[0]) switchItem(taskListArray.value[0][0])
}

const selectAll = () => {
  selected.value = []
  taskList.value.forEach((value, key) => {
    selected.value.push(key)
  })
}

async function cleanAllCompleted () {
  const isConfirm = await showCleanConfirm()
  if (!isConfirm) return
  const completedList: string[] = []

  taskList.value.forEach((item) => {
    if (item.status === STATUS.COMPLETED) {
      completedList.push(item.id)
    }
  })
  console.log(completedList)
  // 删除记录
  store.taskStore().deleteTask(completedList)
  if (taskListArray.value && taskListArray.value[0]) switchItem(taskListArray.value[0][0])
}

function showCleanConfirm () {
  return new Promise((resolve) => {
    Modal.confirm({
      title: '清除所有已完成的任务?',
      content: '不会影响已下载的本地文件',
      icon: false,
      onOk () {
        resolve(true)
      },
      onCancel () {
        resolve(false)
      }
    })
  })
}

onMounted(() => {
  if (!rightTaskId.value) return
  switchItem(rightTaskId.value)
  taskListArray.value.forEach((item, index) => {
    if (item[0] === rightTaskId.value && index >= 3) {
      // 滚动
      left.value.scrollTo({
        top: 83 * (index - 2)
      })
    }
  })
})

function reloadBtnClick (key: string) {
  switchItem(key)
  reloadDownload()
}

</script>

<style scoped lang="less">
.container{
  box-sizing: border-box;
  position: relative;
  flex: 1;
  padding: 16px;
  &.bg-fff{
    background: #ffffff;
  }
  .left{
    flex: 5;
    width: 0;
    border-top: 1px solid #eeeeee;
    border-right: 1px solid #eeeeee;
    overflow-y: overlay;
    .download-item{
      border-bottom: 1px solid #eeeeee;
      cursor: pointer;
      &.error-bg{
        background-color: rgba(0, 0, 0, 0.2);
      }
      &.active{
        background: rgba(251, 114, 153, 0.2);
      }
      .img{
        flex: none;
        width: 106px;
        height: 79px;
        overflow: hidden;
        position: relative;
        img{
          display: block;
          width: 100%;
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
        }
      }
      .content{
        box-sizing: border-box;
        flex: none;
        width: 332px;
        padding: 8px;
        .fx {
          display: flex;
        }
        .process-bar {
          width: 100%;
        }
        .reload {
          width: 20px;
          text-align: center;
          color: rgb(251, 114, 153);
        }
      }
    }
  }
  .right{
    position: relative;
    flex: 3;
    width: 0;
    .image{
      height: 179px;
      overflow: hidden;
      position: relative;
      img{
        display: block;
        width: 100%;
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
      }
    }
    .operate{
      position: absolute;
      width: 100%;
      bottom: 0px;
      left: 0px;
    }
    .up-list{
      width: 100%;
      overflow-x: scroll;
      &::-webkit-scrollbar{
        display: none;
      }
      .up-name{
        display: block;
        width: 80px;
      }
    }
  }
  .error {
    color: #ff0000;
    font-weight: bold;
  }
  .clean-btn {
    position: fixed;
    right: 20px;
    bottom: 20px;
    font-size: 20px;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    border: 2px solid #eee;
    color: #a1a5ad;
    transition: all 0.1s;
    box-shadow: 0 0 8px #eee;
    &:hover {
      color: @primary-color;
      border-color: @primary-color;
    }
  }
}
:deep(.ant-progress-status-success .ant-progress-text){
  color: @primary-color;
}
</style>
