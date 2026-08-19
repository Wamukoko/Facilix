import { useState } from "react";
import type { FormEvent } from "react";
import type { Paged, Role, StaffUser, Supplier } from "../lib/types";
import { BUILTIN_TRADE_OPTIONS } from "../lib/format";
import { Button, Card, EmptyState, Field, Input, Modal, Select, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { useFetch } from "../lib/useFetch";
import { useAuth } from "../context/AuthContext";
import { useConfig } from "../context/ConfigContext";

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  manager: "Manager",
  technician: "Technician",
  tenant: "Tenant",
  supplier: "Supplier",
};

function RoleBadge({ role }: { role: Role }) {
  const cls =
    role === "admin"
      ? "bg-amber/15 text-amber"
      : role === "manager"
        ? "bg-plumbing/15 text-plumbing"
        : role === "tenant"
          ? "bg-gardening/15 text-gardening"
          : role === "supplier"
            ? "bg-janitorial/15 text-janitorial"
            : "bg-dim/15 text-dim";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>
      {ROLE_LABELS[role] ?? role}
    </span>
  );
}

// Who's who in the org. Staff are internal accounts; tenants are residents with
// portal logins; contractors are the supplier companies behind the contractor
// portal. Grouping them makes the roster readable and shows which accounts
// each role manages.
type Cat = "all" | "staff" | "tenants" | "contractors";

const CATEGORIES: { id: Exclude<Cat, "all">; label: string; desc: string; dot: string }[] = [
  {
    id: "staff",
    label: "Team",
    desc: "Internal staff — admins, managers and technicians with work-order access",
    dot: "bg-amber",
  },
  {
    id: "tenants",
    label: "Tenants",
    desc: "Residents with a portal login for reporting and tracking requests",
    dot: "bg-gardening",
  },
  {
    id: "contractors",
    label: "Contractors & suppliers",
    desc: "External service providers behind the contractor portal",
    dot: "bg-janitorial",
  },
];

function SectionHeader({ label, desc, count, dot }: { label: string; desc: string; count: number; dot: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
          <span className={`h-2 w-2 rounded-full ${dot}`} />
          {label}
        </h2>
        <p className="text-xs text-dim">{desc}</p>
      </div>
      <span className="inline-flex items-center rounded-full bg-panel-2 px-2 py-0.5 text-xs font-semibold text-dim">
        {count}
      </span>
    </div>
  );
}

export default function Team() {
  const { user } = useAuth();
  const { config, tradeLabel } = useConfig();
  const trades = config?.trades?.filter((t) => t.active) ?? BUILTIN_TRADE_OPTIONS;
  const canAdd = user?.role === "admin" || user?.role === "manager";
  const isAdmin = user?.role === "admin";

  const { data, loading, error, reload } = useFetch<{ data: StaffUser[] }>("/users");
  const { data: suppliersData } = useFetch<Paged<Supplier>>("/suppliers", { limit: 200 });

  const [cat, setCat] = useState<Cat>("all");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    full_name: "",
    email: "",
    password: "",
    role: "technician" as Role,
    trade: "",
    phone: "",
  });
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (loading) return <Spinner />;
  if (error) return <Card className="p-4 text-danger">{error}</Card>;

  const rows = data?.data ?? [];
  const staffRows = rows.filter((u) => u.role !== "tenant");
  const tenantRows = rows.filter((u) => u.role === "tenant");
  const supplierRows = suppliersData?.data ?? [];

  const show = (c: Exclude<Cat, "all">) => cat === "all" || cat === c;

  const counts: { id: Cat; label: string; count: number }[] = [
    { id: "all", label: "All", count: staffRows.length + tenantRows.length + supplierRows.length },
    { id: "staff", label: "Staff", count: staffRows.length },
    { id: "tenants", label: "Tenants", count: tenantRows.length },
    { id: "contractors", label: "Contractors", count: supplierRows.length },
  ];

  const closeForm = () => {
    setShowForm(false);
    setForm({ full_name: "", email: "", password: "", role: "technician", trade: "", phone: "" });
    setActionError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setActionError(null);
    try {
      await api.post("/users", {
        full_name: form.full_name,
        email: form.email,
        password: form.password,
        role: form.role,
        trade: form.trade || null,
        phone: form.phone || null,
      });
      closeForm();
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not add user");
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (u: StaffUser) => {
    const removing = u.active;
    if (removing && !window.confirm(`Remove ${u.full_name}? They can no longer log in, but their history stays.`)) {
      return;
    }
    setBusyId(u.id);
    try {
      await api.patch(`/users/${u.id}`, { active: !u.active });
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not update user");
    } finally {
      setBusyId(null);
    }
  };

  const deleteForever = async (u: StaffUser) => {
    const sure = window.confirm(
      `Permanently delete ${u.full_name}? This removes their account, notifications, and competency certificates. Their work orders, documents, and permits stay but are unlinked. This cannot be undone.`
    );
    if (!sure) return;
    const really = window.confirm(
      `This is permanent and cannot be reversed. Delete ${u.full_name}'s account for good?`
    );
    if (!really) return;
    setBusyId(u.id);
    try {
      await api.del(`/users/${u.id}`);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not delete user");
    } finally {
      setBusyId(null);
    }
  };

  const userRow = (u: StaffUser) => (
    <tr
      key={u.id}
      className={`border-b border-line last:border-0 hover:bg-panel-2/60 ${u.active ? "" : "opacity-50"}`}
    >
      <td className="px-4 py-3 font-medium text-ink">{u.full_name}</td>
      <td className="px-4 py-3 text-dim">{u.email}</td>
      <td className="hidden px-4 py-3 text-dim sm:table-cell">{u.trade ? tradeLabel(u.trade) : "—"}</td>
      <td className="px-4 py-3">
        <RoleBadge role={u.role} />
      </td>
      <td className="px-4 py-3">
        {u.active ? (
          <span className="inline-flex items-center rounded-full bg-gardening/15 px-2 py-0.5 text-xs font-semibold text-gardening">
            Active
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-dim/10 px-2 py-0.5 text-xs font-semibold text-dim">
            Inactive
          </span>
        )}
      </td>
      {isAdmin ? (
        <td className="px-4 py-3 text-right">
          <div className="inline-flex items-center gap-2">
            {u.id !== user?.id ? (
              <>
                <Button
                  variant="ghost"
                  className="!px-2 !py-1 text-xs"
                  disabled={busyId === u.id}
                  onClick={() => toggleActive(u)}
                >
                  {u.active ? "Remove" : "Restore"}
                </Button>
                <Button
                  variant="ghost"
                  className="!px-2 !py-1 text-xs !text-danger hover:!bg-danger/10"
                  disabled={busyId === u.id}
                  onClick={() => deleteForever(u)}
                >
                  Delete
                </Button>
              </>
            ) : (
              <span className="text-xs text-dim">You</span>
            )}
          </div>
        </td>
      ) : null}
    </tr>
  );

  const userTable = (list: StaffUser[]) => (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b border-line text-xs uppercase tracking-wide text-dim">
          <th className="px-4 py-2 font-semibold">Name</th>
          <th className="px-4 py-2 font-semibold">Email</th>
          <th className="hidden px-4 py-2 font-semibold sm:table-cell">Trade</th>
          <th className="px-4 py-2 font-semibold">Role</th>
          <th className="px-4 py-2 font-semibold">Status</th>
          {isAdmin ? <th className="px-4 py-2 font-semibold text-right">Actions</th> : null}
        </tr>
      </thead>
      <tbody>{list.map(userRow)}</tbody>
    </table>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Team</h1>
          <p className="text-sm text-dim">
            Everyone in the org — staff accounts, resident logins and external contractors.
            {isAdmin ? " Removing a member revokes their login but keeps their history." : ""}
          </p>
        </div>
        {canAdd ? <Button onClick={() => setShowForm(true)}>Add staff</Button> : null}
      </div>

      <div className="inline-flex flex-wrap rounded-lg border border-line bg-panel p-0.5">
        {counts.map((c) => (
          <button
            key={c.id}
            onClick={() => setCat(c.id)}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
              cat === c.id ? "bg-panel-2 text-ink" : "text-dim hover:text-ink"
            }`}
          >
            {c.label}
            <span
              className={`inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-xs ${
                cat === c.id ? "bg-amber/15 text-amber" : "bg-bg text-dim"
              }`}
            >
              {c.count}
            </span>
          </button>
        ))}
      </div>

      {show("staff") ? (
        <Card className="overflow-hidden">
          <SectionHeader label={CATEGORIES[0].label} desc={CATEGORIES[0].desc} count={staffRows.length} dot={CATEGORIES[0].dot} />
          {staffRows.length === 0 ? (
            <EmptyState title="No staff yet" body="Add members so they can log in and get assigned work." />
          ) : (
            userTable(staffRows)
          )}
        </Card>
      ) : null}

      {show("tenants") ? (
        <Card className="overflow-hidden">
          <SectionHeader label={CATEGORIES[1].label} desc={CATEGORIES[1].desc} count={tenantRows.length} dot={CATEGORIES[1].dot} />
          {tenantRows.length === 0 ? (
            <EmptyState title="No tenants yet" body="Add a member with the Tenant role to give them a resident portal login." />
          ) : (
            userTable(tenantRows)
          )}
        </Card>
      ) : null}

      {show("contractors") ? (
        <Card className="overflow-hidden">
          <SectionHeader label={CATEGORIES[2].label} desc={CATEGORIES[2].desc} count={supplierRows.length} dot={CATEGORIES[2].dot} />
          {supplierRows.length === 0 ? (
            <EmptyState title="No contractors yet" body="Supplier companies appear here once they're set up." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-line text-xs uppercase tracking-wide text-dim">
                    <th className="px-4 py-2 font-semibold">Company</th>
                    <th className="px-4 py-2 font-semibold">Trade</th>
                    <th className="hidden px-4 py-2 font-semibold md:table-cell">Contact</th>
                    <th className="px-4 py-2 font-semibold">Type</th>
                    <th className="hidden px-4 py-2 font-semibold sm:table-cell">Since</th>
                  </tr>
                </thead>
                <tbody>
                  {supplierRows.map((s) => (
                    <tr key={s.id} className="border-b border-line last:border-0 hover:bg-panel-2/60">
                      <td className="px-4 py-3 font-medium text-ink">{s.name}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center rounded-full bg-janitorial/15 px-2 py-0.5 text-xs font-semibold text-janitorial">
                          {s.trade ? tradeLabel(s.trade) : "General"}
                        </span>
                      </td>
                      <td className="hidden px-4 py-3 text-dim md:table-cell">
                        {s.contact_name ? (
                          <>
                            {s.contact_name}
                            {s.contact_email ? (
                              <span className="block text-xs text-dim/70">{s.contact_email}</span>
                            ) : null}
                          </>
                        ) : s.contact_email ? (
                          s.contact_email
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${
                            s.is_internal ? "bg-panel-2 text-ink" : "bg-janitorial/15 text-janitorial"
                          }`}
                        >
                          {s.is_internal ? "Internal team" : "External"}
                        </span>
                      </td>
                      <td className="hidden px-4 py-3 text-dim sm:table-cell">
                        {s.created_at ? new Date(s.created_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      <Modal open={showForm} onClose={closeForm} title="Add member">
        <form onSubmit={submit} className="space-y-4">
          {actionError ? <p className="text-sm text-danger">{actionError}</p> : null}
          <Field label="Full name">
            <Input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} required placeholder="e.g. Amina Yusuf" />
          </Field>
          <Field label="Email">
            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required placeholder="e.g. amina@rafiki.co.ke" />
          </Field>
          <Field label="Temporary password">
            <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required placeholder="min. 8 characters" minLength={8} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Role">
              <Select
                value={form.role}
                onChange={(e) => {
                  const role = e.target.value as Role;
                  setForm({ ...form, role, trade: role === "tenant" ? "" : form.trade });
                }}
              >
                <option value="technician">Technician</option>
                <option value="manager">Manager</option>
                <option value="tenant">Tenant</option>
                {user?.role === "admin" ? <option value="admin">Admin</option> : null}
              </Select>
            </Field>
            {form.role !== "tenant" ? (
              <Field label="Trade">
                <Select value={form.trade} onChange={(e) => setForm({ ...form, trade: e.target.value })}>
                  <option value="">—</option>
                  {trades.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
          </div>
          <Field label="Phone">
            <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="optional" />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={closeForm}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Adding…" : "Add member"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
