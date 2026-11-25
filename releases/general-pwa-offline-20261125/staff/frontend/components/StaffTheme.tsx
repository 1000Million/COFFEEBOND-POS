import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from 'react';
import { Moon, Sun } from 'lucide-react';
import './StaffTheme.css';
type Appearance = 'light' | 'dark';
const KEY = 'coffee-bond-staff-appearance', LEGACY = 'coffee-bond-reporting-appearance';
let sessionAppearance: Appearance = 'light';
const ThemeContext = createContext<Appearance | null>(null);
export const useStaffAppearance = () => useContext(ThemeContext);
function readAppearance(): Appearance {
  try { const saved = localStorage.getItem(KEY) || localStorage.getItem(LEGACY); if (saved === 'light' || saved === 'dark') sessionAppearance = saved; } catch { /* Session preference survives restricted storage. */ }
  return sessionAppearance;
}
export default function StaffTheme({ children }: { children: ReactNode }) {
  const [appearance, setAppearance] = useState<Appearance>(readAppearance);
  useLayoutEffect(() => {
    const root = document.documentElement, previous = root.dataset.staffTheme, wasDark = root.classList.contains('dark');
    root.dataset.staffTheme = appearance;
    root.classList.toggle('dark', appearance === 'dark');
    return () => { root.classList.toggle('dark', wasDark); if (previous == null) delete root.dataset.staffTheme; else root.dataset.staffTheme = previous; };
  }, [appearance]);
  const choose = (value: Appearance) => { sessionAppearance = value; setAppearance(value); try { localStorage.setItem(KEY, value); } catch { /* Switching is independent of storage. */ } };
  return <ThemeContext.Provider value={appearance}><div className={`staff-theme${appearance === 'dark' ? ' dark' : ''}`} data-staff-appearance={appearance}>
    <button type="button" className="staff-theme-toggle" role="switch" aria-label="Dark mode" aria-checked={appearance === 'dark'} title={appearance === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} onClick={() => choose(appearance === 'dark' ? 'light' : 'dark')}>
      {appearance === 'dark' ? <Moon size={16} aria-hidden="true"/> : <Sun size={16} aria-hidden="true"/>}
      <span className="staff-theme-switch-track" aria-hidden="true"><span/></span>
    </button>{children}</div></ThemeContext.Provider>;
}
