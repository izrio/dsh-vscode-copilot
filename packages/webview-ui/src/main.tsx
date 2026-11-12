import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles/index.css';
import { watchAccent } from './theme.ts';

watchAccent();

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
