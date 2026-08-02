import { useId, useRef } from 'react';

interface Tab {
  id: string;
  label: string;
  count?: number;
}

interface ModuleTabsProps {
  tabs: Tab[];
  activeTab: string;
  onChange: (id: string) => void;
  variant?: 'pills' | 'underline';
  ariaLabel?: string;
}

export default function ModuleTabs({ tabs, activeTab, onChange, variant = 'pills', ariaLabel = 'Sections' }: ModuleTabsProps) {
  const groupId = useId();
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function selectByKeyboard(index: number, direction: -1 | 1) {
    if (tabs.length === 0) return;
    const nextIndex = (index + direction + tabs.length) % tabs.length;
    onChange(tabs[nextIndex].id);
    buttonRefs.current[nextIndex]?.focus();
  }

  function tabButtonProps(tab: Tab, index: number) {
    return {
      id: `${groupId}-tab-${tab.id}`,
      type: 'button' as const,
      role: 'tab' as const,
      'aria-selected': activeTab === tab.id,
      tabIndex: activeTab === tab.id ? 0 : -1,
      ref: (element: HTMLButtonElement | null) => { buttonRefs.current[index] = element; },
      onClick: () => onChange(tab.id),
      onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault();
          selectByKeyboard(index, 1);
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault();
          selectByKeyboard(index, -1);
        } else if (event.key === 'Home') {
          event.preventDefault();
          onChange(tabs[0].id);
          buttonRefs.current[0]?.focus();
        } else if (event.key === 'End') {
          event.preventDefault();
          const last = tabs.length - 1;
          onChange(tabs[last].id);
          buttonRefs.current[last]?.focus();
        }
      },
    };
  }

  if (variant === 'underline') {
    return (
      <div className="flex items-center gap-0 border-b border-[var(--b1)]" role="tablist" aria-label={ariaLabel}>
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            {...tabButtonProps(tab, index)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === tab.id
                ? 'border-[var(--indigo)] text-indigo'
                : 'border-transparent text-t3 hover:text-t1 hover:border-[var(--b2)]'
            }`}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
                activeTab === tab.id ? 'badge badge-indigo' : 'badge badge-blue'
              }`}>
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 bg-[var(--s3)] p-1 rounded-xl" role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          {...tabButtonProps(tab, index)}
          className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-sm font-semibold transition-all ${
            activeTab === tab.id
              ? 'bg-[var(--s2)] text-t1 shadow-sm'
              : 'text-t3 hover:text-t2'
          }`}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded-full ${
              activeTab === tab.id ? 'badge badge-indigo' : 'badge badge-blue'
            }`}>
              {tab.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
