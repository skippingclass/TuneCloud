import { createContext, useContext, useState, useEffect } from 'react';

export const THEMES = [
  { id: 'peach', name: 'Peach Sunset', primary: '#FFB7B2', secondary: '#FED6BC' },
  { id: 'violet', name: 'Cyber Violet', primary: '#c084fc', secondary: '#e879f9' },
  { id: 'cyan', name: 'Neon Cyan', primary: '#38bdf8', secondary: '#2dd4bf' },
  { id: 'emerald', name: 'Emerald Mint', primary: '#34d399', secondary: '#a3e635' },
  { id: 'monochrome', name: 'Monochrome Silver', primary: '#f8fafc', secondary: '#cbd5e1' },
  { id: 'oled', name: 'Midnight OLED', primary: '#ffffff', secondary: '#a1a1aa' },
  { id: 'cyberpunk', name: 'Cyberpunk Neon', primary: '#ff007f', secondary: '#00f0ff' },
  { id: 'nord', name: 'Nordic Frost', primary: '#88c0d0', secondary: '#81a1c1' },
  { id: 'crimson', name: 'Crimson Velvet', primary: '#f43f5e', secondary: '#fb7185' },
  { id: 'amber', name: 'Tokyo Sunset', primary: '#f59e0b', secondary: '#fb923c' },
];

const THEME_KEY = 'tunecloud-theme';
const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem(THEME_KEY) || 'peach';
    } catch {
      return 'peach';
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {}

    const root = document.documentElement;
    THEMES.forEach((t) => root.classList.remove(`theme-${t.id}`));
    root.classList.add(`theme-${theme}`);
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, themes: THEMES }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
