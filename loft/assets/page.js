const dialog = document.querySelector("#figure-dialog");
const pane = dialog.querySelector(".dialog-pane");
const zoom = document.querySelector("#zoom-button");
const detail = document.querySelector("#detail-image");

function setZoom(large) {
  pane.classList.toggle("zoomed", large);
  zoom.setAttribute("aria-pressed", String(large));
  zoom.textContent = large ? "Fit to window" : "Zoom in";
  if (!large) pane.scrollTo(0, 0);
}

for (const link of document.querySelectorAll("[data-figure]")) {
  link.addEventListener("click", event => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !dialog.showModal) return;
    event.preventDefault();
    const method = link.dataset.figure === "method";
    dialog.querySelector("h2").textContent = method ? "Figure 2 · LoFT architecture" : "Figure 1 · Reconstruction and benchmarks";
    detail.alt = method ? "Architecture of the LoFT visual and camera refinement loops." : "The street reconstruction, four input frames and radar plots comparing depth, pose and trajectory accuracy on three benchmarks.";
    detail.src = link.href;
    setZoom(false);
    dialog.showModal();
    document.querySelector("#close-dialog").focus();
  });
}
zoom.addEventListener("click", () => setZoom(!pane.classList.contains("zoomed")));
detail.addEventListener("click", () => setZoom(!pane.classList.contains("zoomed")));
document.querySelector("#close-dialog").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", event => {
  if (event.target !== dialog) return;
  const box = dialog.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
});

const navLinks = [...document.querySelectorAll("nav a")];
const anchors = navLinks.map(link => document.querySelector(link.hash));
let queued = false;
function updateNavigation() {
  const offset = document.querySelector(".site-header").offsetHeight + 32;
  let active = 0;
  anchors.forEach((section, index) => {
    if (section.getBoundingClientRect().top <= offset) active = index;
  });
  if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2) active = anchors.length - 1;
  navLinks.forEach((link, index) => {
    if (index === active) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  });
  queued = false;
}
function queueNavigation() {
  if (!queued) {
    queued = true;
    requestAnimationFrame(updateNavigation);
  }
}
window.addEventListener("scroll", queueNavigation, {passive: true});
window.addEventListener("resize", queueNavigation);
window.addEventListener("load", updateNavigation);
updateNavigation();

for (const root of document.querySelectorAll('[data-loft-viewer]')) {
  const button = root.querySelector('button');
  let observer;
  async function startViewer() {
    if (button.disabled) return;
    observer?.disconnect();
    button.disabled = true;
    button.textContent = 'Loading point cloud…';
    try {
      const url = new URL(root.dataset.loftViewer, document.baseURI);
      const {mountViewer} = await import(url.href);
      mountViewer(root);
    } catch {
      button.disabled = false;
      button.textContent = 'Retry loading the viewer';
    }
  }
  button.addEventListener('click', startViewer);
  if ('IntersectionObserver' in window) {
    observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) startViewer();
    });
    observer.observe(root.closest('section') || root);
  }
}
