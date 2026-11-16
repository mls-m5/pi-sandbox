// Only a plain Enter submits. Leave IME confirmation, Shift+Enter and other
// modified keys to the browser; suppress held-key repeats to avoid resubmission.
export function handlePromptKey(event, submit) {
  if (
    event.defaultPrevented ||
    event.key !== 'Enter' ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.shiftKey ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey
  )
    return false;
  event.preventDefault();
  if (!event.repeat) submit();
  return true;
}
