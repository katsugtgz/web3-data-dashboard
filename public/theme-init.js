try {
  var s = localStorage.getItem('color-scheme');
  if (s === 'light' || s === 'dark') {
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.content = s;
  }
} catch (_) {}
