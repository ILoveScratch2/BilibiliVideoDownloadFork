// ... existing imports ...

const handleContextMenu = (e: MouseEvent, task: TaskData) => {
  e.preventDefault()
  const taskStore = useTaskStore()
  
  const menuItems = [
    // ... existing menu items ...
    {
      label: task.status === STATUS.PAUSED ? '继续下载' : '暂停下载',
      visible: [STATUS.DOWNLOADING, STATUS.PAUSED].includes(task.status),
      click: () => {
        if (task.status === STATUS.PAUSED) {
          taskStore.resumeTask(task.id)
        } else {
          taskStore.pauseTask(task.id)
        }
      }
    }
  ]
  
  // ... existing context menu code ...
}