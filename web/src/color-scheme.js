// Loaded as a blocking script in <head> so the first paint already uses the theme that
// prefers-color-scheme asks for. theme.css switches tokens on the .dark class.
const query = window.matchMedia('(prefers-color-scheme: dark)');
const apply = () => document.documentElement.classList.toggle('dark', query.matches);
apply();
query.addEventListener('change', apply);
