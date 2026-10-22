// Applies the saved (or OS) light/dark mode and color theme before first paint to avoid a flash.
// Kept as an external file so the Content-Security-Policy does not need to allow inline scripts.
(function () {
  var mode = null, palette = null;
  try {
    mode = localStorage.getItem("cctv-theme");
    palette = localStorage.getItem("cctv-palette");
  } catch (e) {}
  var dark = mode === "dark" || ((!mode || mode === "system") && window.matchMedia("(prefers-color-scheme: dark)").matches);
  var root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.dataset.theme = dark ? "dark" : "light";
  if (palette && palette !== "blue") root.dataset.palette = palette;
})();
