import { ChevronLeft, ChevronRight, Search, Menu } from 'lucide-react';

export function Header({
  canGoBack,
  onBack,
  canGoForward,
  onForward,
  searchQuery,
  onSearchChange,
  onOpenSidebar,
  currentViewTitle,
}) {
  return (
    <header className="h-16 px-4 sm:px-6 glass-panel border-b border-white/[0.06] flex items-center justify-between gap-4 shrink-0 select-none z-30">
      {/* Left: Mobile menu toggle + Navigation history */}
      <div className="flex items-center gap-2">
        <button
          onClick={onOpenSidebar}
          className="lg:hidden p-2 rounded-xl text-surface-400 hover:text-white hover:bg-white/[0.06] transition-colors"
          title="Open Menu"
        >
          <Menu className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-1">
          <button
            onClick={onBack}
            disabled={!canGoBack}
            className={`p-2 rounded-xl transition-all ${
              canGoBack
                ? 'text-surface-300 hover:text-white hover:bg-white/[0.06]'
                : 'text-surface-600 opacity-40 cursor-default'
            }`}
            title="Go Back"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={onForward}
            disabled={!canGoForward}
            className={`p-2 rounded-xl transition-all ${
              canGoForward
                ? 'text-surface-300 hover:text-white hover:bg-white/[0.06]'
                : 'text-surface-600 opacity-40 cursor-default'
            }`}
            title="Go Forward"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {currentViewTitle && (
          <div className="hidden sm:flex items-center gap-2 pl-3 border-l border-white/[0.08]">
            <h2 className="text-sm font-semibold text-surface-200 capitalize">
              {currentViewTitle}
            </h2>
          </div>
        )}
      </div>

      {/* Center / Right: Global Search Bar */}
      <div className="flex-1 max-w-md relative">
        <Search className="w-4 h-4 text-surface-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          type="text"
          value={searchQuery || ''}
          onChange={(e) => onSearchChange?.(e.target.value)}
          placeholder="Search tracks, albums, artists..."
          className="glass-input w-full pl-9 pr-4 py-1.5 text-xs sm:text-sm bg-white/[0.025]"
        />
      </div>
    </header>
  );
}
