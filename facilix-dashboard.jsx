import React, { useState, useMemo } from "react";
import {
  Droplet, Zap, Trees, SprayCan, LayoutGrid, ClipboardList,
  KanbanSquare, Plus, X, AlertTriangle, Clock, CheckCircle2,
  Wrench, ChevronRight, Search
} from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid, Cell } from "recharts";

// ---------------------------------------------------------------
// Design tokens
// bg:      #14181C  (near-black graphite, blueprint-adjacent)
// panel:   #1C2126
// line:    #2A3138  (hairline grid)
// ink:     #E9EDF1
// dim:     #8A939C
// amber:   #E8A33D  (signature accent — like a hazard/service tag)
// trades:  plumbing #4C9FE8 / electrical #E8A33D / gardening #6FBF73 / janitorial #C689E0
// ---------------------------------------------------------------

const TRADES = {
  plumbing:   { label: "Plumbing",   color: "#4C9FE8", Icon: Droplet },
  electrical: { label: "Electrical", color: "#E8A33D", Icon: Zap },
  gardening:  { label: "Gardening",  color: "#6FBF73", Icon: Trees },
  janitorial: { label: "Janitorial", color: "#C689E0", Icon: SprayCan },
};

const seedAssets = [
  { id: "a1", name: "Main Water Heater — B1", trade: "plumbing", room: "Mech Room, Bldg A", status: "active", nextService: "Sep 02" },
  { id: "a2", name: "Panel MDP-2", trade: "electrical", room: "Electrical Rm, Bldg A", status: "active", nextService: "Aug 20" },
  { id: "a3", name: "Front Lawn Irrigation", trade: "gardening", room: "Site — North Yard", status: "active", nextService: "Aug 16" },
  { id: "a4", name: "Lobby Floor Scrubber", trade: "janitorial", room: "Lobby, Bldg A", status: "under_repair", nextService: "—" },
  { id: "a5", name: "Riser Shutoff Valve 4F", trade: "plumbing", room: "Unit 4B", status: "active", nextService: "Oct 11" },
  { id: "a6", name: "Emergency Lighting Loop", trade: "electrical", room: "Stairwell C", status: "active", nextService: "Aug 25" },
];

const seedOrders = [
  { id: "w1", title: "Leaking faucet — Unit 4B", trade: "plumbing", priority: "high", status: "open", source: "tenant_request", asset: "Unit 4B" },
  { id: "w2", title: "Quarterly panel inspection — MDP-2", trade: "electrical", priority: "normal", status: "open", source: "plan", asset: "Panel MDP-2" },
  { id: "w3", title: "Trim hedges — North Yard", trade: "gardening", priority: "low", status: "assigned", source: "plan", asset: "North Yard" },
  { id: "w4", title: "Restock lobby supplies", trade: "janitorial", priority: "normal", status: "in_progress", source: "breakdown", asset: "Lobby" },
  { id: "w5", title: "Water heater pressure check", trade: "plumbing", priority: "normal", status: "in_progress", source: "plan", asset: "Water Heater B1" },
  { id: "w6", title: "Broken light — Stairwell C", trade: "electrical", priority: "urgent", status: "open", source: "breakdown", asset: "Stairwell C" },
  { id: "w7", title: "Irrigation controller reset", trade: "gardening", priority: "normal", status: "done", source: "breakdown", asset: "Irrigation" },
  { id: "w8", title: "Deep clean — common areas", trade: "janitorial", priority: "low", status: "done", source: "plan", asset: "Common Areas" },
];

const seedPlans = [
  { id: "p1", name: "Quarterly plumbing inspection", trade: "plumbing", trigger: "Scheduled · every 90 days" },
  { id: "p2", name: "Electrical panel check", trade: "electrical", trigger: "Scheduled · every 180 days" },
  { id: "p3", name: "Irrigation service", trade: "gardening", trigger: "Meter-based · every 500L used" },
  { id: "p4", name: "Daily lobby janitorial round", trade: "janitorial", trigger: "Scheduled · every 1 day" },
];

const STATUS_COLS = [
  { key: "open", label: "Open", Icon: AlertTriangle },
  { key: "assigned", label: "Assigned", Icon: Clock },
  { key: "in_progress", label: "In Progress", Icon: Wrench },
  { key: "done", label: "Done", Icon: CheckCircle2 },
];

const PRIORITY_STYLE = {
  urgent: { bg: "rgba(232,79,79,0.15)", fg: "#E86F6F" },
  high:   { bg: "rgba(232,163,61,0.15)", fg: "#E8A33D" },
  normal: { bg: "rgba(138,147,156,0.15)", fg: "#8A939C" },
  low:    { bg: "rgba(138,147,156,0.10)", fg: "#6B747C" },
};

function TradeBadge({ trade, small }) {
  const t = TRADES[trade];
  const Icon = t.Icon;
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        fontSize: small ? 11 : 12, fontWeight: 600, letterSpacing: 0.2,
        color: t.color, background: `${t.color}1A`,
        padding: small ? "2px 7px" : "3px 9px", borderRadius: 5,
      }}
    >
      <Icon size={small ? 11 : 13} strokeWidth={2.4} />
      {t.label}
    </span>
  );
}

function Card({ children, style }) {
  return (
    <div
      style={{
        background: "#1C2126",
        border: "1px solid #2A3138",
        borderRadius: 10,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Dashboard({ assets, orders }) {
  const counts = useMemo(() => {
    const byStatus = { open: 0, assigned: 0, in_progress: 0, done: 0 };
    orders.forEach((o) => (byStatus[o.status] = (byStatus[o.status] || 0) + 1));
    return byStatus;
  }, [orders]);

  const byTrade = useMemo(() => {
    return Object.keys(TRADES).map((key) => ({
      trade: TRADES[key].label,
      open: orders.filter((o) => o.trade === key && o.status !== "done").length,
      color: TRADES[key].color,
    }));
  }, [orders]);

  const urgent = orders.filter((o) => o.priority === "urgent" || o.priority === "high");

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
        {STATUS_COLS.map(({ key, label, Icon }) => (
          <Card key={key} style={{ padding: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div style={{ color: "#8A939C", fontSize: 12, fontWeight: 600, letterSpacing: 0.5, textTransform: "uppercase" }}>
                  {label}
                </div>
                <div style={{ color: "#E9EDF1", fontSize: 30, fontWeight: 700, marginTop: 6, fontFamily: "'JetBrains Mono', monospace" }}>
                  {counts[key] || 0}
                </div>
              </div>
              <Icon size={18} color="#4A525A" />
            </div>
          </Card>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 14 }}>
        <Card style={{ padding: 20 }}>
          <div style={{ color: "#E9EDF1", fontWeight: 600, fontSize: 14, marginBottom: 14 }}>
            Open work by trade
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={byTrade}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2A3138" vertical={false} />
              <XAxis dataKey="trade" stroke="#8A939C" fontSize={12} tickLine={false} axisLine={{ stroke: "#2A3138" }} />
              <YAxis stroke="#8A939C" fontSize={12} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip
                contentStyle={{ background: "#1C2126", border: "1px solid #2A3138", borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: "#E9EDF1" }}
                cursor={{ fill: "rgba(255,255,255,0.03)" }}
              />
              <Bar dataKey="open" radius={[4, 4, 0, 0]}>
                {byTrade.map((entry, i) => (
                  <Cell key={i} fill={entry.color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card style={{ padding: 20 }}>
          <div style={{ color: "#E9EDF1", fontWeight: 600, fontSize: 14, marginBottom: 14 }}>
            Needs attention
          </div>
          <div style={{ display: "grid", gap: 10 }}>
            {urgent.length === 0 && (
              <div style={{ color: "#6B747C", fontSize: 13 }}>Nothing urgent right now.</div>
            )}
            {urgent.map((o) => (
              <div key={o.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderLeft: `3px solid ${TRADES[o.trade].color}`, paddingLeft: 10 }}>
                <div>
                  <div style={{ color: "#E9EDF1", fontSize: 13, fontWeight: 500 }}>{o.title}</div>
                  <div style={{ color: "#6B747C", fontSize: 11, marginTop: 2 }}>{o.asset}</div>
                </div>
                <span style={{
                  fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4,
                  color: PRIORITY_STYLE[o.priority].fg, background: PRIORITY_STYLE[o.priority].bg,
                  padding: "3px 7px", borderRadius: 4,
                }}>
                  {o.priority}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card style={{ padding: 20 }}>
        <div style={{ color: "#E9EDF1", fontWeight: 600, fontSize: 14, marginBottom: 14 }}>
          Upcoming service
        </div>
        <div style={{ display: "grid", gap: 8 }}>
          {assets.filter(a => a.nextService !== "—").sort((a,b) => a.nextService.localeCompare(b.nextService)).map((a) => (
            <div key={a.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #2A3138" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <TradeBadge trade={a.trade} small />
                <span style={{ color: "#E9EDF1", fontSize: 13 }}>{a.name}</span>
                <span style={{ color: "#6B747C", fontSize: 12 }}>{a.room}</span>
              </div>
              <span style={{ color: "#8A939C", fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }}>{a.nextService}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function AssetsView({ assets }) {
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");

  const filtered = assets.filter((a) => {
    if (filter !== "all" && a.trade !== filter) return false;
    if (search && !a.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ position: "relative" }}>
          <Search size={14} color="#6B747C" style={{ position: "absolute", left: 10, top: 10 }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search assets..."
            style={{
              background: "#1C2126", border: "1px solid #2A3138", borderRadius: 8,
              padding: "8px 12px 8px 30px", color: "#E9EDF1", fontSize: 13, width: 220, outline: "none",
            }}
          />
        </div>
        <button onClick={() => setFilter("all")} style={pillStyle(filter === "all")}>All</button>
        {Object.entries(TRADES).map(([key, t]) => (
          <button key={key} onClick={() => setFilter(key)} style={pillStyle(filter === key, t.color)}>
            <t.Icon size={12} style={{ marginRight: 5, verticalAlign: -2 }} />
            {t.label}
          </button>
        ))}
      </div>

      <Card>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1.4fr 1fr 1fr", padding: "12px 18px", borderBottom: "1px solid #2A3138", fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: "#6B747C" }}>
          <div>Asset</div><div>Trade</div><div>Location</div><div>Status</div><div>Next service</div>
        </div>
        {filtered.map((a) => (
          <div key={a.id} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1.4fr 1fr 1fr", padding: "14px 18px", borderBottom: "1px solid #2A3138", alignItems: "center" }}>
            <div style={{ color: "#E9EDF1", fontSize: 13, fontWeight: 500 }}>{a.name}</div>
            <div><TradeBadge trade={a.trade} small /></div>
            <div style={{ color: "#8A939C", fontSize: 13 }}>{a.room}</div>
            <div>
              <span style={{
                fontSize: 11, fontWeight: 600, color: a.status === "active" ? "#6FBF73" : "#E8A33D",
                background: a.status === "active" ? "rgba(111,191,115,0.12)" : "rgba(232,163,61,0.12)",
                padding: "3px 8px", borderRadius: 4,
              }}>
                {a.status === "active" ? "Active" : "Under repair"}
              </span>
            </div>
            <div style={{ color: "#8A939C", fontSize: 13, fontFamily: "'JetBrains Mono', monospace" }}>{a.nextService}</div>
          </div>
        ))}
        {filtered.length === 0 && <div style={{ padding: 30, textAlign: "center", color: "#6B747C", fontSize: 13 }}>No assets match.</div>}
      </Card>
    </div>
  );
}

function pillStyle(active, color) {
  return {
    background: active ? (color ? `${color}22` : "#2A3138") : "transparent",
    color: active ? (color || "#E9EDF1") : "#8A939C",
    border: `1px solid ${active ? (color || "#3A424A") : "#2A3138"}`,
    borderRadius: 20, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer",
  };
}

function WorkOrdersBoard({ orders, setOrders }) {
  const [showNew, setShowNew] = useState(false);
  const [draft, setDraft] = useState({ title: "", trade: "plumbing", priority: "normal", asset: "" });

  function move(id, newStatus) {
    setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, status: newStatus } : o)));
  }

  function addOrder() {
    if (!draft.title.trim()) return;
    setOrders((prev) => [
      { id: `w${Date.now()}`, title: draft.title, trade: draft.trade, priority: draft.priority, status: "open", source: "breakdown", asset: draft.asset || "Unassigned location" },
      ...prev,
    ]);
    setDraft({ title: "", trade: "plumbing", priority: "normal", asset: "" });
    setShowNew(false);
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ color: "#8A939C", fontSize: 13 }}>{orders.length} work orders</div>
        <button
          onClick={() => setShowNew(true)}
          style={{
            display: "flex", alignItems: "center", gap: 6, background: "#E8A33D", color: "#14181C",
            border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer",
          }}
        >
          <Plus size={14} /> Report issue
        </button>
      </div>

      {showNew && (
        <Card style={{ padding: 18 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
            <div style={{ color: "#E9EDF1", fontWeight: 600, fontSize: 14 }}>New breakdown / request</div>
            <X size={16} color="#8A939C" style={{ cursor: "pointer" }} onClick={() => setShowNew(false)} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
            <input
              placeholder="What's the issue? e.g. Leaking faucet — Unit 4B"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              style={inputStyle}
            />
            <select value={draft.trade} onChange={(e) => setDraft({ ...draft, trade: e.target.value })} style={inputStyle}>
              {Object.entries(TRADES).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}
            </select>
            <select value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })} style={inputStyle}>
              {["low", "normal", "high", "urgent"].map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <input
            placeholder="Location / asset (optional)"
            value={draft.asset}
            onChange={(e) => setDraft({ ...draft, asset: e.target.value })}
            style={{ ...inputStyle, width: "100%", marginBottom: 12 }}
          />
          <button onClick={addOrder} style={{ background: "#E8A33D", color: "#14181C", border: "none", borderRadius: 8, padding: "8px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
            Create work order
          </button>
        </Card>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
        {STATUS_COLS.map(({ key, label, Icon }) => {
          const colOrders = orders.filter((o) => o.status === key);
          return (
            <div key={key}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10, color: "#8A939C", fontSize: 12, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase" }}>
                <Icon size={13} /> {label} <span style={{ color: "#4A525A" }}>({colOrders.length})</span>
              </div>
              <div style={{ display: "grid", gap: 8, minHeight: 60 }}>
                {colOrders.map((o) => (
                  <Card key={o.id} style={{ padding: 12, borderLeft: `3px solid ${TRADES[o.trade].color}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 6 }}>
                      <div style={{ color: "#E9EDF1", fontSize: 12.5, fontWeight: 500, lineHeight: 1.35 }}>{o.title}</div>
                    </div>
                    <div style={{ color: "#6B747C", fontSize: 11, marginTop: 6 }}>{o.asset}</div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10 }}>
                      <span style={{
                        fontSize: 10, fontWeight: 700, textTransform: "uppercase",
                        color: PRIORITY_STYLE[o.priority].fg, background: PRIORITY_STYLE[o.priority].bg,
                        padding: "2px 6px", borderRadius: 4,
                      }}>
                        {o.priority}
                      </span>
                      {STATUS_COLS.findIndex(s => s.key === key) < STATUS_COLS.length - 1 && (
                        <button
                          onClick={() => move(o.id, STATUS_COLS[STATUS_COLS.findIndex(s => s.key === key) + 1].key)}
                          style={{ background: "none", border: "none", color: "#8A939C", cursor: "pointer", display: "flex", alignItems: "center", fontSize: 10 }}
                          title="Advance"
                        >
                          <ChevronRight size={14} />
                        </button>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const inputStyle = {
  background: "#14181C", border: "1px solid #2A3138", borderRadius: 6,
  padding: "8px 10px", color: "#E9EDF1", fontSize: 13, outline: "none",
};

function PlansView({ plans }) {
  return (
    <Card>
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1.5fr", padding: "12px 18px", borderBottom: "1px solid #2A3138", fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: "#6B747C" }}>
        <div>Plan</div><div>Trade</div><div>Trigger</div>
      </div>
      {plans.map((p) => (
        <div key={p.id} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1.5fr", padding: "14px 18px", borderBottom: "1px solid #2A3138", alignItems: "center" }}>
          <div style={{ color: "#E9EDF1", fontSize: 13, fontWeight: 500 }}>{p.name}</div>
          <div><TradeBadge trade={p.trade} small /></div>
          <div style={{ color: "#8A939C", fontSize: 13 }}>{p.trigger}</div>
        </div>
      ))}
    </Card>
  );
}

export default function App() {
  const [tab, setTab] = useState("dashboard");
  const [orders, setOrders] = useState(seedOrders);
  const assets = seedAssets;
  const plans = seedPlans;

  const tabs = [
    { key: "dashboard", label: "Dashboard", Icon: LayoutGrid },
    { key: "assets", label: "Assets", Icon: ClipboardList },
    { key: "orders", label: "Work Orders", Icon: KanbanSquare },
    { key: "plans", label: "Maintenance Plans", Icon: Wrench },
  ];

  return (
    <div style={{
      background: "#14181C", minHeight: "100vh", fontFamily: "'Inter', 'Helvetica Neue', sans-serif",
      backgroundImage: "linear-gradient(#1A1F24 1px, transparent 1px), linear-gradient(90deg, #1A1F24 1px, transparent 1px)",
      backgroundSize: "32px 32px",
    }}>
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "28px 24px 60px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 26 }}>
          <div>
            <div style={{ color: "#4A525A", fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", fontFamily: "'JetBrains Mono', monospace" }}>
              PROPERTY & FACILITY MAINTENANCE
            </div>
            <div style={{ color: "#E9EDF1", fontSize: 22, fontWeight: 700, marginTop: 2 }}>
              Facilix
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {Object.values(TRADES).map((t) => (
              <span key={t.label} style={{ width: 8, height: 8, borderRadius: "50%", background: t.color }} title={t.label} />
            ))}
          </div>
        </div>

        <div style={{ display: "flex", gap: 4, marginBottom: 24, borderBottom: "1px solid #2A3138" }}>
          {tabs.map(({ key, label, Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                background: "none", border: "none", cursor: "pointer",
                padding: "10px 14px", fontSize: 13, fontWeight: 600,
                color: tab === key ? "#E8A33D" : "#8A939C",
                borderBottom: tab === key ? "2px solid #E8A33D" : "2px solid transparent",
                marginBottom: -1,
              }}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>

        {tab === "dashboard" && <Dashboard assets={assets} orders={orders} />}
        {tab === "assets" && <AssetsView assets={assets} />}
        {tab === "orders" && <WorkOrdersBoard orders={orders} setOrders={setOrders} />}
        {tab === "plans" && <PlansView plans={plans} />}
      </div>
    </div>
  );
}
