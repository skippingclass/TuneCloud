import { createContext, useContext, useState, useEffect } from 'react';

export const THEMES = [
  { id: 'peach', name: 'Peach Sunset', primary: '#FFB7B2', secondary: '#FED6BC' },
  { id: 'violet', name: 'Cyber Violet', primary: '#c084fc', secondary: '#e879f9' },
  { id: 'cyan', name: 'Neon Cyan', primary: '#38bdf8', secondary: '#2dd4bf' },
  { id: 'emerald', name: 'Emerald Mint', primary: '#34d399', secondary: '#a3e635' },
  { id: 'monochrome', name: 'Monochrome Silver', primary: '#f8fafc', secondary: '#cbd5e1' },
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
