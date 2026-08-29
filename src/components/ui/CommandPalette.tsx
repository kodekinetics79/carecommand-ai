import { useState, useEffect, useRef } from 'react';
import { Search, Megaphone, Users, Phone, TrendingUp, Star, BarChart2, UserPlus, Zap, X, ArrowRight, Orbit } from 'lucide-react';
import { useNavigate } from 'react-router';
import { canOpenPath, type RoutePath } from '../../lib/access';
import type { SessionUser } from '../../lib/session';
import type { CampaignHandoff } from '../../lib/crm';

interface Command {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  // Declared destinations only — the same registry the sidebar gates on, so a
  // command can never offer a page the user's role does not cover.
  path?: RoutePath;
  /** Context carried into the campaign workspace so it isn't asked for again. */
  handoff?: CampaignHandoff;
  action?: string;
  category: string;
}

const commands: Command[] = [
  { id: 'c1', label: 'Create campaign', description: 'Open campaign setup and review', icon: <Megaphone className="w-4 h-4" />, path: '/campaigns', handoff: { source: 'Command palette' }, action: 'navigate', category: 'Actions' },
  { id: 'c2', label: 'Find patient', description: 'Search patient profiles and history', icon: <Search className="w-4 h-4" />, path: '/patients', action: 'navigate', category: 'Actions' },
  { id: 'c3', label: 'Review missed calls', description: 'Open the missed-call follow-up queue', icon: <Phone className="w-4 h-4" />, path: '/ai-receptionist', action: 'navigate', category: 'Actions' },
  { id: 'c4', label: 'View inactive patients', description: 'Review inactive and at-risk patient records', icon: <Users className="w-4 h-4" />, path: '/crm', action: 'navigate', category: 'Actions' },
  { id: 'c5', label: 'Review reputation', description: 'Open reviews, responses, and campaign setup', icon: <Star className="w-4 h-4" />, path: '/reviews', action: 'navigate', category: 'Actions' },
  { id: 'c6', label: 'Open revenue report', description: 'Review revenue records and trends', icon: <TrendingUp className="w-4 h-4" />, path: '/revenue', action: 'navigate', category: 'Reports' },
  { id: 'c7', label: 'Assign staff follow-up', description: 'Open staff tasks and assignments', icon: <UserPlus className="w-4 h-4" />, path: '/staff', action: 'navigate', category: 'Actions' },
  { id: 'c8', label: 'View branch signals', description: 'Compare available records across locations', icon: <BarChart2 className="w-4 h-4" />, path: '/clinic-radar', action: 'navigate', category: 'Reports' },
  { id: 'c9', label: 'Open ClinicRadar', description: 'Review stored operational and market signals', icon: <Zap className="w-4 h-4" />, path: '/clinic-radar', action: 'navigate', category: 'Insights' },
  { id: 'c10', label: 'Open scheduling', description: 'Review appointments and available slots', icon: <Zap className="w-4 h-4" />, path: '/scheduling', action: 'navigate', category: 'Actions' },
  { id: 'c11', label: 'Open CareFlow Autopilot', description: 'Review playbooks, approvals, and recorded actions', icon: <Orbit className="w-4 h-4" />, path: '/autopilot', action: 'navigate', category: 'Automation' },
];

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  /** Signed-in user, so commands are filtered to destinations they can open. */
  user?: SessionUser | null;
}

export default function CommandPalette({ isOpen, onClose, user }: CommandPaletteProps) {
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

  // Same rule as the sidebar: a destination the user's grants do not cover is
  // not offered here either.
  const available = commands.filter(c => !c.path || canOpenPath(user, c.path));
  const filtered = query
    ? available.filter(c => c.label.toLowerCase().includes(query.toLowerCase()) || c.description.toLowerCase().includes(query.toLowerCase()))
    : available;

  const grouped = filtered.reduce<Record<string, Command[]>>((acc, cmd) => {
    if (!acc[cmd.category]) acc[cmd.category] = [];
    acc[cmd.category].push(cmd);
    return acc;
  }, {});

  const handleSelect = (cmd: Command) => {
    if (cmd.path) navigate(cmd.path, cmd.handoff ? { state: cmd.handoff } : undefined);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh] cmd-backdrop" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command search"
        className="w-full max-w-xl glass-surface rounded-2xl overflow-hidden animate-fade-in"
        onClick={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-[var(--b1)]">
          <Search className="w-4 h-4 text-t3 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            aria-label="Search commands"
            placeholder="Search commands, patients, and campaigns…"
            className="flex-1 text-sm text-t1 placeholder:text-t3 bg-transparent outline-none"
          />
          <div className="flex items-center gap-1.5">
            <kbd className="text-[10px] font-semibold text-t3 bg-[var(--s3)] px-1.5 py-0.5 rounded">ESC</kbd>
            <button type="button" onClick={onClose} aria-label="Close command search" className="w-6 h-6 flex items-center justify-center rounded-lg hover:bg-[var(--s3)] text-t3">
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
              <p className="text-sm font-semibold text-t2">No matching commands</p>
              <p className="mt-1 text-xs text-t3">Try a module or task name instead of “{query}”.</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 border-t border-[var(--b1)] flex items-center gap-4 text-[11px] text-t3">
          <span>Select an item to open it.</span>
          <span className="ml-auto flex items-center gap-1"><kbd className="bg-[var(--s3)] px-1.5 py-0.5 rounded font-semibold">Esc</kbd> Close</span>
        </div>
      </div>
    </div>
  );
}
