const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Data management (renderer handles Firestore, main normalizes)
  initData: (rawData, empresa) => ipcRenderer.invoke('data:init', rawData, empresa),
  normalizeData: (data) => ipcRenderer.invoke('data:normalize', data),

  // Calculator
  calculate: (payload) => ipcRenderer.invoke('calc:calculate', payload),
  updateCalcState: (payload) => ipcRenderer.invoke('calc:update-state', payload),

  // Orders
  saveOrderFromResult: (resultInfo) => ipcRenderer.invoke('orders:save-from-result', resultInfo),
  setOrderAccepted: (orderId, partnerStock) => ipcRenderer.invoke('orders:set-accepted', orderId, partnerStock),
  setOrderSent: (orderId) => ipcRenderer.invoke('orders:set-sent', orderId),
  deleteOrder: (orderId) => ipcRenderer.invoke('orders:delete', orderId),
  updateOrder: (params) => ipcRenderer.invoke('orders:update', params),
  recalculateOrder: (params) => ipcRenderer.invoke('orders:recalculate', params),
  addManualOrderPayment: (params) => ipcRenderer.invoke('orders:add-manual-payment', params),
  removeOrderPaymentRecord: (params) => ipcRenderer.invoke('orders:remove-payment-record', params),
  duplicateOrder: (orderId) => ipcRenderer.invoke('orders:duplicate', orderId),
  generateOrderPaymentLink: (params) => ipcRenderer.invoke('orders:generate-payment-link', params),

  // Email notifications
  sendOrderStatusEmail: (params) => ipcRenderer.invoke('mail:send-status', params),
  sendTestEmail: (params) => ipcRenderer.invoke('mail:send-test', params),

  // Tickets & utilities
  getTickets: (info) => ipcRenderer.invoke('tickets:get', info),
  saveTicketPdf: (payload) => ipcRenderer.invoke('tickets:save-pdf', payload),
  getTicketPdfBuffer: (payload) => ipcRenderer.invoke('tickets:get-pdf-buffer', payload),
  saveBothPdfs: (payload) => ipcRenderer.invoke('tickets:save-both-pdfs', payload),
  openUrl: (url) => ipcRenderer.invoke('shell:open-url', url),
  openFile: (filePath) => ipcRenderer.invoke('shell:open-file', filePath),
  showItemInFolder: (filePath) => ipcRenderer.invoke('shell:show-item-in-folder', filePath),
  openImageFilePicker: () => ipcRenderer.invoke('dialog:open-image-file'),
  readImageAsBase64: (filePath) => ipcRenderer.invoke('shell:read-image-as-base64', filePath),
  selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),
  copyText: (text) => ipcRenderer.invoke('clipboard:write-text', String(text || '')),
});
