import { createRoot } from 'react-dom/client';
import { App } from './app.jsx';

// Styles are built separately by Tailwind from src/app.css.
createRoot(document.getElementById('root')).render(<App/>);
