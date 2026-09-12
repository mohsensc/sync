import type { Clerk } from '@clerk/clerk-js'
import './account-settings.css'

export function addAuthHomeLink(authGate: HTMLElement) {
  const link = document.createElement('a')
  link.id = 'auth-home'
  link.className = 'quiet-button auth-home'
  link.href = '/'
  link.textContent = '← Back to home'
  authGate.prepend(link)
}

export function setupAccountSettings(clerk: Clerk, beforeDelete: () => Promise<void>) {
  const trigger = document.getElementById('account-settings') as HTMLButtonElement
  const dialog = document.createElement('dialog')
  dialog.className = 'account-dialog'
  dialog.setAttribute('aria-labelledby', 'account-title')
  dialog.innerHTML = `
    <div class="account-dialog-heading"><div><p class="eyebrow">Your workspace</p><h2 id="account-title">Account settings</h2></div><button class="quiet-button" type="button" data-close aria-label="Close account settings">Close</button></div>
    <p class="muted">Manage your profile, session, and account.</p>
    <div class="account-action"><div><h3>Profile & security</h3><p>Update your name, email, password, and sign-in methods.</p></div><button class="quiet-button" type="button" data-profile>Manage profile</button></div>
    <div class="account-action"><div><h3>Log out</h3><p>End this session and return to the home page.</p></div><button class="quiet-button" type="button" data-logout>Log out</button></div>
    <div class="account-action account-danger"><div><h3>Delete account</h3><p>Permanently delete your account, personal workspace, activity, and setup tokens. This cannot be undone.</p></div><button class="quiet-button danger" type="button" data-delete>Delete account…</button></div>
    <form class="account-confirm" hidden><label for="delete-confirmation">Type DELETE to confirm</label><input id="delete-confirmation" name="confirmation" autocomplete="off" spellcheck="false" required pattern="DELETE" /><div class="account-confirm-actions"><button class="quiet-button" type="button" data-cancel>Cancel</button><button class="primary-button" type="submit" disabled>Permanently delete account</button></div></form>
    <p class="error" role="alert" data-error hidden></p>`
  document.body.append(dialog)
  const element = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!
  const form = element<HTMLFormElement>('form')
  const input = element<HTMLInputElement>('input')
  const submit = element<HTMLButtonElement>('[type="submit"]')
  const error = element('[data-error]')
  let busy = false
  function showError(cause: unknown) {
    error.textContent = cause instanceof Error ? cause.message : 'Something went wrong. Please try again.'
    error.hidden = false
  }
  function setBusy(value: boolean) {
    busy = value
    dialog.setAttribute('aria-busy', String(value))
    dialog.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = value })
    input.disabled = value
    submit.disabled = value || input.value !== 'DELETE'
  }
  trigger.onclick = () => {
    form.hidden = true
    input.value = ''
    submit.disabled = true
    error.hidden = true
    dialog.showModal()
  }
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault() })
  dialog.addEventListener('close', () => trigger.focus())
  element('[data-close]').onclick = () => dialog.close()
  element('[data-profile]').onclick = () => {
    dialog.close()
    clerk.openUserProfile({ appearance: { elements: { profileSection__danger: { display: 'none' } } } })
  }
  const logout = async () => {
    setBusy(true)
    error.hidden = true
    try { await clerk.signOut({ redirectUrl: '/' }) }
    catch (cause) { showError(cause); setBusy(false) }
  }
  element('[data-logout]').onclick = () => void logout()
  const headerLogout = document.getElementById('sign-out') as HTMLButtonElement
  headerLogout.onclick = () => {
    dialog.showModal()
    void logout()
  }
  element('[data-delete]').onclick = () => { form.hidden = false; input.focus() }
  element('[data-cancel]').onclick = () => {
    form.hidden = true
    input.value = ''
    submit.disabled = true
    element('[data-delete]').focus()
  }
  input.oninput = () => { submit.disabled = input.value !== 'DELETE' }
  form.onsubmit = async event => {
    event.preventDefault()
    if (busy || input.value !== 'DELETE') return
    setBusy(true)
    error.hidden = true
    submit.textContent = 'Deleting account…'
    try {
      await beforeDelete()
      const response = await fetch('/api/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: input.value }),
      })
      const result = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(result.error || 'Could not delete your account. Please try again.')
      // The server has removed the identity. Clear the browser's session too;
      // a stale local session must not leave the deleted dashboard on screen.
      await clerk.signOut({ redirectUrl: '/' }).catch(() => window.location.assign('/'))
    } catch (cause) {
      showError(cause)
      setBusy(false)
      submit.textContent = 'Permanently delete account'
    }
  }
}
