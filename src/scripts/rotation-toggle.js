// One "Pause image rotation" button per section of rotating images (the cards
// themselves are links, so the control can't sit inside them). It sets
// <html data-rotation="paused">, which every rotation checks before each step.
// Under prefers-reduced-motion the rotations never start and the button hides.
document.querySelectorAll('[data-rotation-toggle]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const root = document.documentElement;
    const paused = root.dataset.rotation !== 'paused';
    if (paused) root.dataset.rotation = 'paused';
    else delete root.dataset.rotation;
    document.querySelectorAll('[data-rotation-toggle]').forEach((b) => {
      b.setAttribute('aria-pressed', String(paused));
      b.textContent = paused ? 'Resume image rotation' : 'Pause image rotation';
    });
  });
});
