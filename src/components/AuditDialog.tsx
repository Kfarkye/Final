import React, { useState, useEffect, useMemo } from 'react';
import { motion } from 'motion/react';
import { X, ShieldAlert, Activity, Download, Search, Filter } from 'lucide-react';
import { logAuditAction } from '../lib/audit';

interface AuditLog {
  id: number;
  userId: string;
  email: string;
  action: string;
  details: any;
  createdAt: string;
}

export default function AuditDialog({ onClose, currentUser }: { onClose: () => void, currentUser: any }) {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');

  // Filtering state
  const [searchTerm, setSearchTerm] = useState('');
  const [actionFilter, setActionFilter] = useState<string>('ALL');

  useEffect(() => {
    // SECURITY WARNING: Client-side authorization is easily bypassed.
    // The server API must strictly enforce permissions.
    if (!currentUser || currentUser.role !== 'Admin') {
      setErrorMsg("Access Denied: Enterprise Admin privileges required.");
      setLoading(false);
      return;
    }

    fetch(`/api/audit?userId=${currentUser.uid}`)
      .then(res => {
        if (!res.ok) {
          throw new Error("Failed to load audit records.");
        }
        return res.json();
      })
      .then(data => {
        setLogs(data);
        setLoading(false);
      })
      .catch(err => {
        console.error(err);
        setErrorMsg("Failed to retrieve system logs. Please contact support.");
        setLoading(false);
      });
  }, [currentUser]);

  const uniqueActions = useMemo(() => {
    const actions = new Set(logs.map(l => l.action));
    return ['ALL', ...Array.from(actions)];
  }, [logs]);

  const filteredLogs = useMemo(() => {
    return logs.filter(log => {
      const matchesSearch = log.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
        JSON.stringify(log.details || {}).toLowerCase().includes(searchTerm.toLowerCase());
      const matchesAction = actionFilter === 'ALL' || log.action === actionFilter;
      return matchesSearch && matchesAction;
    });
  }, [logs, searchTerm, actionFilter]);

  const handleExport = () => {
    // Mitigate CSV Formula Injection by prepending ' to potential cell-formulas starting with =, +, -, @, \t, or \r
    const sanitizeForCSV = (val: any): string => {
      if (val === null || val === undefined) return '';
      const stringVal = typeof val === 'object' ? JSON.stringify(val) : String(val);

      const escaped = stringVal.replace(/"/g, '""');
      if (/^[=\+\-\@\t\r]/.test(stringVal)) {
        return `'${escaped}`;
      }
      return escaped;
    };

    const headers = ["ID", "Date", "User", "Action", "Details"];
    const rows = filteredLogs.map(log => [
      log.id.toString(),
      new Date(log.createdAt).toISOString(),
      log.email,
      log.action,
      log.details
    ]);

    // Build standard-compliant double-quoted CSV payload
    const csvContentString = [headers, ...rows]
      .map(row => row.map(cell => `"${sanitizeForCSV(cell)}"`).join(","))
      .join("\n");

    // Use Blobs to support large payloads securely and avoid URI encoding length limitations
    const blob = new Blob([csvContentString], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `audit_report_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    logAuditAction(currentUser, 'EXPORT_AUDIT', { format: 'CSV', count: filteredLogs.length });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="bg-zinc-950 border border-white/10 rounded-2xl w-full max-w-5xl overflow-hidden shadow-2xl flex flex-col h-[85vh]"
      >
        <div className="p-6 border-b border-white/10 flex justify-between items-center bg-black">
          <h2 className="text-lg font-medium text-white flex items-center gap-2">
            <ShieldAlert size={18} className="text-red-400" /> Enterprise Audit & Compliance Console
          </h2>
          <div className="flex items-center gap-4">
            {!errorMsg && (
              <button
                onClick={handleExport}
                className="flex items-center gap-2 px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-xs font-semibold text-white transition-colors"
              >
                <Download size={16} /> Export CSV
              </button>
            )}
            <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors">
              <X size={18} />
            </button>
          </div>
        </div>

        {!errorMsg && !loading && (
          <div className="px-6 py-4 border-b border-white/5 bg-zinc-900/50 flex flex-col sm:flex-row gap-4 items-center justify-between">
            <div className="relative flex-1 w-full max-w-md">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
              <input
                type="text"
                placeholder="Search user, payload..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="w-full bg-black border border-white/10 rounded-lg pl-10 pr-4 py-2 text-sm text-white focus:border-white/30 focus:outline-none placeholder-zinc-600 transition-all"
              />
            </div>
            <div className="flex items-center gap-3 w-full sm:w-auto">
              <Filter size={16} className="text-zinc-500" />
              <select
                value={actionFilter}
                onChange={e => setActionFilter(e.target.value)}
                className="bg-black border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-white/30 focus:outline-none transition-all"
              >
                {uniqueActions.map(action => (
                  <option key={action} value={action}>{action}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-6 bg-zinc-950/50">
          {errorMsg ? (
            <div className="flex items-center justify-center h-full text-red-500 font-medium tracking-wide">
              {errorMsg}
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center h-full text-zinc-500 text-sm tracking-widest uppercase">
              Loading logs...
            </div>
          ) : filteredLogs.length === 0 ? (
            <div className="flex items-center justify-center h-full text-zinc-500">
              No audit logs match criteria.
            </div>
          ) : (
            <div className="space-y-4">
              {filteredLogs.map((log) => (
                <div key={log.id} className="border border-white/5 bg-black rounded-xl p-4 flex flex-col gap-2 hover:border-white/10 transition-colors">
                  <div className="flex justify-between items-start">
                    <div className="flex items-center gap-3">
                      <Activity size={16} className="text-zinc-500" />
                      <span className="font-mono text-xs font-semibold uppercase tracking-wider text-emerald-400">{log.action}</span>
                    </div>
                    <span className="text-xs font-mono text-zinc-500">{new Date(log.createdAt).toLocaleString()}</span>
                  </div>
                  <div className="text-sm text-zinc-300">
                    User: <span className="text-white font-medium">{log.email}</span>
                  </div>
                  <div className="bg-zinc-900 border border-white/5 rounded-lg p-3 text-xs font-mono text-zinc-400 overflow-x-auto mt-2 whitespace-pre-wrap">
                    {log.details ? JSON.stringify(log.details, null, 2) : 'No additional details'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}
