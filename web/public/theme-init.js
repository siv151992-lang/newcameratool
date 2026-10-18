// Applies the saved (or OS) theme before first paint to avoid a flash. Kept as an external
// file so the Content-Security-Policy does not need to allow inline scripts.
(function () {
  var stored = null;
  try { stored = localStorage.getItem("cctv-theme"); } catch (e) {}
  var dark = stored ? stored === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();
