// Native dialog supplies modal focus trapping, Escape and focus restoration.
// Desktop stays a non-modal grid panel; no private state is persisted here.
export function createAgentDrawer({
  document,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
}) {
  const panel = document.getElementById('agent-panel'),
    button = document.getElementById('agent-menu'),
    closeButton = document.getElementById('agent-menu-close');
  const media = matchMedia?.('(max-width: 720px)');
  let active = false;
  if (!media || typeof panel.showModal !== 'function' || typeof panel.show !== 'function') {
    button.hidden = true;
    return { setActive() {}, close() {}, destroy() {} };
  }
  panel.classList.add('drawer-supported');
  function expanded() {
    button.setAttribute('aria-expanded', String(media.matches && panel.open));
  }
  function close() {
    if (media.matches && panel.open) panel.close();
    expanded();
  }
  function layout() {
    if (panel.open) panel.close();
    if (!media.matches) panel.show();
    button.hidden = !active || !media.matches;
    expanded();
  }
  button.addEventListener('click', () => {
    if (!active || !media.matches) return;
    if (panel.open) close();
    else {
      panel.showModal();
      expanded();
    }
  });
  closeButton.addEventListener('click', close);
  panel.addEventListener('close', expanded);
  panel.addEventListener('click', (event) => {
    if (event.target !== panel || !media.matches || !panel.open) return;
    const bounds = panel.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      close();
  });
  media.addEventListener('change', layout);
  layout();
  return {
    close,
    setActive(value) {
      active = value === true;
      if (!active) close();
      button.hidden = !active || !media.matches;
    },
    destroy() {
      active = false;
      close();
      media.removeEventListener('change', layout);
      button.hidden = true;
    },
  };
}
