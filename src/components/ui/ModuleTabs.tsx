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
}

export default function ModuleTabs({ tabs, activeTab, onChange, variant = 'pills' }: ModuleTabsProps) {
  if (variant === 'underline') {
    return (
      <div className="flex items-center gap-0 border-b border-[var(--b1)]">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
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
    <div className="flex items-center gap-1 bg-[var(--s3)] p-1 rounded-xl">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
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
