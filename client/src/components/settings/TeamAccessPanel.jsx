import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { fetchTeam, addTeamMember, updateTeamMember, removeTeamMember } from '../../lib/api';

// Who may sign in and what they may open. The plant has several process coordinators, and until
// now adding one meant editing the server's environment variables and redeploying.
//
// The server is the authority on all of this (services/access.service.js): this page only shows
// and edits the list. Addresses in ADMIN_EMAILS are read-only here on purpose — that setting is
// the way back in if the list is ever emptied by mistake.

const FOCUS_RING = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--series-1)]';
const BUTTON = `rounded-full border px-3 py-1 text-xs font-medium transition-colors hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`;
const FIELD = `rounded-lg border-0 px-3 py-2 text-sm ${FOCUS_RING}`;

const BLANK = { email: '', name: '', title: '', role: 'manager', sections: ['dashboard'] };

export function TeamAccessPanel() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(BLANK);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // email being edited

  const teamQuery = useQuery({ queryKey: ['team'], queryFn: fetchTeam, staleTime: 30_000 });
  const team = teamQuery.data;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['team'] });
  const onError = (err) => setError(err?.response?.data?.error || 'That did not work. Please try again.');

  const addMutation = useMutation({
    mutationFn: addTeamMember,
    onSuccess: () => {
      setDraft(BLANK);
      setError('');
      refresh();
    },
    onError,
  });
  // Applied to the list straight away rather than after the round trip: a tick box that stays
  // unticked until the server answers reads as a broken control. If the server refuses — the
  // last admin, an address fixed by ADMIN_EMAILS — the list goes back to what it was and says
  // why.
  const updateMutation = useMutation({
    mutationFn: ({ email, changes }) => updateTeamMember(email, changes),
    onMutate: async ({ email, changes }) => {
      await queryClient.cancelQueries({ queryKey: ['team'] });
      const previous = queryClient.getQueryData(['team']);
      queryClient.setQueryData(['team'], (current) =>
        current && {
          ...current,
          members: current.members.map((m) => (m.email === email ? { ...m, ...changes } : m)),
        });
      return { previous };
    },
    onError: (err, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(['team'], context.previous);
      onError(err);
    },
    onSuccess: () => setError(''),
    onSettled: refresh,
  });
  const removeMutation = useMutation({ mutationFn: removeTeamMember, onSuccess: () => { setError(''); refresh(); }, onError });

  function toggleDraftSection(key) {
    setDraft((d) => ({ ...d, sections: d.sections.includes(key) ? d.sections.filter((s) => s !== key) : [...d.sections, key] }));
  }

  function toggleMemberSection(member, key) {
    const sections = member.sections.includes(key) ? member.sections.filter((s) => s !== key) : [...member.sections, key];
    updateMutation.mutate({ email: member.email, changes: { sections } });
  }

  function handleAdd(e) {
    e.preventDefault();
    setError('');
    addMutation.mutate({ ...draft, email: draft.email.trim().toLowerCase() });
  }

  function handleRemove(member) {
    if (!window.confirm(`Remove ${member.email}? They will not be able to sign in unless your login domain still allows them.`)) return;
    removeMutation.mutate(member.email);
  }

  const sections = team?.sections ?? [];
  const busy = addMutation.isPending || updateMutation.isPending || removeMutation.isPending;

  return (
    <div className="mt-4 rounded-2xl border p-5" style={{ background: 'var(--surface-1)' }}>
      <div className="mb-1 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
        People and access
      </div>
      <div className="mb-4 text-xs" style={{ color: 'var(--text-muted)' }}>
        Add a colleague's work email and tick the sections they may open. Changes apply the next time
        they load a page — they do not have to sign out.
        {team?.loginDomains?.length ? ` Anyone at ${team.loginDomains.join(', ')} can already sign in and see the dashboard; add them here to give them more, or switch them off.` : ''}
      </div>

      {error && (
        <div role="alert" className="mb-3 text-xs" style={{ color: 'var(--status-critical)' }}>
          {error}
        </div>
      )}

      <form onSubmit={handleAdd} className="mb-5 rounded-xl border p-3" style={{ borderColor: 'var(--baseline)' }}>
        <div className="grid gap-2 sm:grid-cols-3">
          <input
            type="email"
            required
            value={draft.email}
            onChange={(e) => setDraft({ ...draft, email: e.target.value })}
            placeholder="name@salasartechno.com"
            aria-label="Email address"
            className={FIELD}
            style={{ background: 'var(--surface-2)', color: 'var(--text-primary)' }}
          />
          <input
            type="text"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="Full name (optional)"
            aria-label="Full name"
            className={FIELD}
            style={{ background: 'var(--surface-2)', color: 'var(--text-primary)' }}
          />
          <input
            type="text"
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder="Role, e.g. Process Coordinator — HSD"
            aria-label="Role on the plant"
            className={FIELD}
            style={{ background: 'var(--surface-2)', color: 'var(--text-primary)' }}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
            Access level
            <select
              value={draft.role}
              onChange={(e) => setDraft({ ...draft, role: e.target.value })}
              className={`rounded-lg px-2 py-1 text-sm ${FOCUS_RING}`}
              style={{ background: 'var(--surface-2)', color: 'var(--text-primary)' }}
            >
              <option value="manager">Manager — only the sections ticked</option>
              <option value="admin">Admin — every section, and this page</option>
            </select>
          </label>

          <div className="flex flex-wrap items-center gap-3">
            {sections.map((section) => (
              <label key={section.key} className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }} title={section.label}>
                <input
                  type="checkbox"
                  checked={draft.role === 'admin' || draft.sections.includes(section.key)}
                  disabled={draft.role === 'admin'}
                  onChange={() => toggleDraftSection(section.key)}
                  className={FOCUS_RING}
                />
                {section.label.split('—')[0].trim()}
              </label>
            ))}
          </div>

          <button type="submit" disabled={busy} className={`ml-auto rounded-full px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50 ${FOCUS_RING}`} style={{ background: 'var(--series-1)' }}>
            {addMutation.isPending ? 'Adding…' : 'Add person'}
          </button>
        </div>
      </form>

      {teamQuery.isPending ? (
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading the list…</div>
      ) : (
        <ul className="space-y-2">
          {team?.members?.length === 0 && (
            <li className="text-sm" style={{ color: 'var(--text-muted)' }}>
              Nobody has been added yet.
            </li>
          )}
          {team?.members?.map((member) => (
            <li key={member.email} className="rounded-xl border p-3" style={{ borderColor: 'var(--baseline)', opacity: member.active ? 1 : 0.6 }}>
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                    {member.name || member.email}
                    {member.role === 'admin' && (
                      <span className="ml-2 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase" style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}>
                        Admin
                      </span>
                    )}
                    {!member.active && (
                      <span className="ml-2 text-[10px] font-semibold uppercase" style={{ color: 'var(--status-critical)' }}>
                        Switched off
                      </span>
                    )}
                  </div>
                  <div className="truncate text-xs" style={{ color: 'var(--text-muted)' }}>
                    {member.email}
                    {member.title ? ` · ${member.title}` : ''}
                    {member.lastLoginAt ? ` · last signed in ${format(new Date(member.lastLoginAt), 'd MMM yyyy')}` : ' · never signed in'}
                  </div>
                </div>

                <div className="flex shrink-0 flex-wrap gap-1">
                  <button type="button" onClick={() => setEditing(editing === member.email ? null : member.email)} className={BUTTON} style={{ color: 'var(--text-secondary)' }}>
                    {editing === member.email ? 'Done' : 'Edit'}
                  </button>
                  <button
                    type="button"
                    disabled={busy || member.fixedByEnv}
                    onClick={() => updateMutation.mutate({ email: member.email, changes: { active: !member.active } })}
                    className={BUTTON}
                    style={{ color: 'var(--text-secondary)' }}
                    title={member.fixedByEnv ? 'Set by the server’s ADMIN_EMAILS' : 'Keep the record, but block sign-in'}
                  >
                    {member.active ? 'Switch off' : 'Switch on'}
                  </button>
                  <button type="button" disabled={busy || member.fixedByEnv} onClick={() => handleRemove(member)} className={BUTTON} style={{ color: 'var(--status-critical)' }}>
                    Remove
                  </button>
                </div>
              </div>

              {member.fixedByEnv && (
                <div className="mt-2 text-xs" style={{ color: 'var(--status-warning)' }}>
                  An admin through the server's ADMIN_EMAILS setting — their access cannot be changed here.
                </div>
              )}

              {editing === member.email && !member.fixedByEnv && (
                <div className="mt-3 flex flex-wrap items-center gap-4 border-t pt-3" style={{ borderColor: 'var(--baseline)' }}>
                  <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                    Access level
                    <select
                      value={member.role}
                      onChange={(e) => updateMutation.mutate({ email: member.email, changes: { role: e.target.value } })}
                      className={`rounded-lg px-2 py-1 text-sm ${FOCUS_RING}`}
                      style={{ background: 'var(--surface-2)', color: 'var(--text-primary)' }}
                    >
                      <option value="manager">Manager</option>
                      <option value="admin">Admin</option>
                    </select>
                  </label>

                  <div className="flex flex-wrap items-center gap-3">
                    {sections.map((section) => (
                      <label key={section.key} className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }} title={section.label}>
                        <input
                          type="checkbox"
                          checked={member.sections.includes(section.key)}
                          disabled={member.role === 'admin' || busy}
                          onChange={() => toggleMemberSection(member, section.key)}
                          className={FOCUS_RING}
                        />
                        {section.label.split('—')[0].trim()}
                      </label>
                    ))}
                    {member.role === 'admin' && (
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Admins get every section.</span>
                    )}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {team?.envAdmins?.length > 0 && (
        <div className="mt-4 border-t pt-3 text-xs" style={{ borderColor: 'var(--baseline)', color: 'var(--text-muted)' }}>
          Always admins, from the server's ADMIN_EMAILS setting: {team.envAdmins.join(', ')}.
          {team.emailSender ? ` Reports are sent from ${team.emailSender}'s mailbox, whoever writes them.` : ''}
        </div>
      )}
    </div>
  );
}
