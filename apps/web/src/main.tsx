import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { SpriteGallery } from './map/SpriteGallery';
import './styles.css';

// `?gallery` – само при разработка: преглед на всички сгради и дървета.
const gallery = import.meta.env.DEV && new URLSearchParams(location.search).has('gallery');

createRoot(document.getElementById('root')!).render(<StrictMode>{gallery ? <SpriteGallery /> : <App />}</StrictMode>);
