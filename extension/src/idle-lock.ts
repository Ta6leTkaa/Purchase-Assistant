/** Uses wall time too: background-tab timer throttling cannot prolong a session on return. */
export function idleLock(lock: () => void, timeout = 5 * 60 * 1000) {
  let last = Date.now();
  let timer: ReturnType<typeof setTimeout>;
  const check = () => {
    if (Date.now() - last >= timeout) lock();
    else timer = setTimeout(check, timeout - (Date.now() - last));
  };
  const touch = () => {
    if (Date.now() - last >= timeout) lock();
    last = Date.now();
    clearTimeout(timer); timer = setTimeout(check, timeout);
  };
  const focus = () => {if (Date.now() - last >= timeout) lock();};
  for (const name of ["pointerdown", "keydown", "input"]) document.addEventListener(name, touch, true);
  window.addEventListener("focus", focus);
  window.addEventListener("pagehide", lock);
  timer = setTimeout(check, timeout);
  return {touch};
}
