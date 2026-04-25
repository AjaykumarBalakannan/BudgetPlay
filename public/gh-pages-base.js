/* Ensures relative assets resolve on GitHub project pages (e.g. /Repo vs /Repo/). */
(function () {
  var p = location.pathname;
  if (!p || p === '/') return;
  if (!p.endsWith('/')) {
    var slash = p.lastIndexOf('/');
    if (slash >= 0 && p.lastIndexOf('.') > slash) p = p.slice(0, slash + 1);
    else p += '/';
  }
  var b = document.createElement('base');
  b.href = location.origin + p;
  document.head.insertBefore(b, document.head.firstChild);
})();
