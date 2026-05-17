// Load the sidebar navigation into every page
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await fetch('nav.html');
    const html = await res.text();
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.innerHTML = html;

    // Highlight current page in nav
    const current = location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('.sidebar a').forEach(a => {
      const href = a.getAttribute('href');
      if (href === current || href === './' + current) a.classList.add('active');
      // Handle hash links like features.html#mcp
      if (current === 'features.html' && href.startsWith('features.html')) a.classList.add('active');
    });
  } catch {}
});
