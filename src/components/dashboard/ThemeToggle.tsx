import { Moon, Sun } from '@phosphor-icons/react';
import { useTheme } from '../../hooks/useTheme';

type ThemeToggleProps = {
  className?: string;
};

export function ThemeToggle({ className = '' }: ThemeToggleProps) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';

  return (
    <button
      type="button"
      className={`theme-toggle ${className}`}
      onClick={toggleTheme}
      aria-label={isDark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
      aria-pressed={isDark}
      title={isDark ? 'Modo claro' : 'Modo oscuro'}
    >
      {isDark ? <Sun size={18} weight="regular" /> : <Moon size={18} weight="regular" />}
    </button>
  );
}
