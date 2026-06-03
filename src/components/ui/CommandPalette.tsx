import { useState, useEffect, useRef } from 'react';
import { Search, Megaphone, Users, Phone, TrendingUp, Star, BarChart2, UserPlus, Zap, X, ArrowRight, Orbit } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface Command {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  path?: string;
  action?: string;
  category: string;
}

const commands: Command[] = [
  { id: 'c1', label: 'Create Campaign', description: 'Launch a new AI-powered campaign', icon: <Megaphone className="w-4 h-4" />, path: '/campaigner', action: 'navigate', category: 'Actions' },
  { id: 'c2', label: 'Find Customer', description: 'Search customer profiles and history', icon: <Search className="w-4 h-4" />, path: '/patients', action: 'navigate', category: 'Actions' },
  { id: 'c3', label: 'Recover Missed Calls', description: 'View and action missed call queue', icon: <Phone className="w-4 h-4" />, path: '/ai-receptionist', action: 'navigate', category: 'Actions' },
  { id: 'c4', label: 'View Inactive Customers', description: '214 customers at churn risk', icon: <Users className="w-4 h-4" />, path: '/crm', action: 'navigate', category: 'Actions' },
  { id: 'c5', label: 'Launch Review Campaign', description: 'Boost your clinic reputation score', icon: <Star className="w-4 h-4" />, path: '/reviews', action: 'navigate', category: 'Actions' },
  { id: 'c6', label: 'Open Revenue Report', description: 'RevenuePulse CFO dashboard', icon: <TrendingUp className="w-4 h-4" />, path: '/revenue', action: 'navigate', category: 'Reports' },
  { id: 'c7', label: 'Assign Staff Follow-up', description: 'Delegate open tasks to front desk', icon: <UserPlus className="w-4 h-4" />, path: '/staff', action: 'navigate', category: 'Actions' },
  { id: 'c8', label: 'View Branch Performance', description: 'Compare all clinic locations', icon: <BarChart2 className="w-4 h-4" />, path: '/clinic-radar', action: 'navigate', category: 'Reports' },
  { id: 'c9', label: 'ClinicRadar AI Insights', description: "See today's detected revenue signals", icon: <Zap className="w-4 h-4" />, path: '/clinic-radar', action: 'navigate', category: 'AI' },
  { id: 'c10', label: 'Smart Scheduling', description: 'View and fill empty appointment slots', icon: <Zap className="w-4 h-4" />, path: '/scheduling', action: 'navigate', category: 'AI' },
  { id: 'c11', label: 'Open CareFlow Autopilot', description: 'Review agent playbooks, approvals, and audit trail', icon: <Orbit className="w-4 h-4" />, path: '/autopilot', action: 'navigate', category: 'AI' },
];

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        setQuery('');
        inputRef.current?.focus();
      }, 50);
    }
  }, [isOpen]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (isOpen) onClose();
      }
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const filtered = query
    ? commands.filter(c => c.label.toLowerCase().includes(query.toLowerCase()) || c.description.toLowerCase().includes(query.toLowerCase()))
    : commands;

  const grouped = filtered.reduce<Record<string, Command[]>>((acc, cmd) => {
    if (!acc[cmd.category]) acc[cmd.category] = [];
    acc[cmd.category].push(cmd);
    return acc;
  }, {});

  const handleSelect = (cmd: Command) => {
    if (cmd.path) navigate(cmd.path);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh] cmd-backdrop" onClick={onClose}>
      <div
        className="w-full max-w-xl bg-[var(--s2)] rounded-2xl shadow-2xl border border-[var(--b2)] overflow-hidden animate-fade-in"
        onClick={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-[var(--b1)]">
          <Search className="w-4 h-4 text-t3 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search commands, customers, campaigns..."
            className="flex-1 text-sm text-t1 placeholder:text-t3 bg-transparent outline-none"
          />
          <div className="flex items-center gap-1.5">
            <kbd className="text-[10px] font-semibold text-t3 bg-[var(--s3)] px-1.5 py-0.5 rounded">ESC</kbd>
            <button onClick={onClose} className="w-6 h-6 flex items-center justify-center rounded-lg hover:bg-[var(--s3)] text-t3">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Results */}
        <div className="max-h-80 overflow-y-auto py-2">
          {Object.entries(grouped).map(([category, items]) => (
            <div key={category}>
              <div className="px-4 py-1.5">
                <p className="text-[10px] font-bold uppercase tracking-widest text-t3">{category}</p>
              </div>
              {items.map((cmd) => (
                <button
                  key={cmd.id}
                  onClick={() => handleSelect(cmd)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--indigo-soft)] transition-colors text-left group"
                >
                  <div className="w-7 h-7 rounded-lg bg-[var(--s3)] group-hover:bg-[var(--indigo-soft)] flex items-center justify-center text-t3 group-hover:text-indigo transition-colors shrink-0">
                    {cmd.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-t1 group-hover:text-indigo">{cmd.label}</p>
                    <p className="text-xs text-t3 truncate">{cmd.description}</p>
                  </div>
                  <ArrowRight className="w-3.5 h-3.5 text-t3 group-hover:text-indigo opacity-0 group-hover:opacity-100 transition-all" />
                </button>
              ))}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="py-8 text-center">
              <p className="text-sm text-t3">No commands found for "{query}"</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 border-t border-[var(--b1)] flex items-center gap-4 text-[11px] text-t3">
          <span className="flex items-center gap-1"><kbd className="bg-[var(--s3)] px-1.5 py-0.5 rounded font-semibold">↑↓</kbd> Navigate</span>
          <span className="flex items-center gap-1"><kbd className="bg-[var(--s3)] px-1.5 py-0.5 rounded font-semibold">↵</kbd> Select</span>
          <span className="flex items-center gap-1"><kbd className="bg-[var(--s3)] px-1.5 py-0.5 rounded font-semibold">⌘K</kbd> Toggle</span>
        </div>
      </div>
    </div>
  );
}
