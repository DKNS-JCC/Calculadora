import { reactive } from 'vue'

/**
 * Composable to ask for user confirmation before sending a status-change
 * email to a client. Returns a promise that resolves to one of:
 *
 *   'send'   — proceed with the save and send the email
 *   'skip'   — proceed with the save but DO NOT send the email
 *   'cancel' — abort the save entirely
 */
export function useEmailConfirm() {
  const state = reactive({
    visible: false,
    order: null,
    oldStatus: '',
    newStatus: '',
    recipientEmail: '',
    title: '',
    _resolve: null,
  })

  function ask({ order, oldStatus, newStatus, recipientEmail, title }) {
    return new Promise((resolve) => {
      state.order = order || null
      state.oldStatus = oldStatus || ''
      state.newStatus = newStatus || ''
      state.recipientEmail = recipientEmail || ''
      state.title = title || ''
      state._resolve = resolve
      state.visible = true
    })
  }

  function answer(choice) {
    state.visible = false
    const r = state._resolve
    state._resolve = null
    if (r) r(choice)
  }

  return { state, ask, answer }
}
