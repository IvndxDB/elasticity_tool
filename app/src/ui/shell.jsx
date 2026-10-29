/* eslint-disable react-refresh/only-export-components */
// Piezas del shell visual de Pricing L'Oréal / Tiendas Bara (proyecto «Knobolch Cascaron»: sport/, loreal/, bara/).
// Mismo markup y mismas clases para que el CSS copiado en esta carpeta (sport.css, db-ui.css, filtros.css,
// loreal.css, bara.css) se aplique igual. Solo vista: no cambian datos ni lógica.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./sport.css";
import "./loreal.css";
import "./db-ui.css";
import "./filtros.css";
import "./bara.css";
import "./el.css";

/* ── Tema claro / oscuro con la animación «sprint» (useTemaAnimado + Sprint de SportPositioning) ── */
const TEMA_KEY = "sp-tema";
const temaInicial = () => {
  try {
    const t = localStorage.getItem(TEMA_KEY);
    if (t === "light" || t === "dark") return t;
  } catch { /* sin storage: tema del sistema */ }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
};

export function useTemaAnimado() {
  const [tema, setTema] = useState(temaInicial);
  const [sprint, setSprint] = useState(null);
  const cambiarTema = (e) => {
    if (sprint) return;
    const t = tema === "dark" ? "light" : "dark";
    try { localStorage.setItem(TEMA_KEY, t); } catch { /* sin storage */ }
    const sec = e?.currentTarget?.closest(".sp");
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || !sec) return setTema(t);
    const s = sec.getBoundingClientRect();
    const y = Math.min(Math.max(window.innerHeight / 2 - s.top, 80), s.height - 80);
    setSprint({ y });
    setTimeout(() => setTema(t), 450);
    setTimeout(() => setSprint(null), 950);
  };
  return { tema, sprint, cambiarTema };
}

// Ícono de la app (curva de demanda) para el logo del encabezado y la estela del cambio de tema
export const CURVA = <><path d="M4 4v16h16" /><path d="M7 7c1.5 6 5 9.5 12 10.5" /><circle cx="11" cy="12.6" r="1.6" /></>;

const LINEAS = Array.from({ length: 16 }, (_, i) => ({
  top: `${6 + ((i * 37) % 88)}%`,
  width: `${14 + ((i * 53) % 26)}%`,
  c: i % 3 === 0 ? "var(--sp-orange)" : "var(--sp-teal)",
}));

export function Sprint({ y, icono = CURVA }) {
  return (
    <div className="sp-sprint" aria-hidden="true">
      <div className="sp-sprint-band">
        {LINEAS.map((l, i) => <i key={i} style={{ top: l.top, width: l.width, "--c": l.c }} />)}
        <div className="sp-sprint-runner" style={{ top: y }}>
          <svg viewBox="0 0 24 24">{icono}</svg>
        </div>
      </div>
    </div>
  );
}

export function TemaBoton({ tema, onClick }) {
  const claro = tema === "light";
  return (
    <button className={`sp-switch ${claro ? "on" : ""}`} onClick={onClick} role="switch" aria-checked={claro}
      title={claro ? "Modo oscuro" : "Modo claro"} aria-label="Modo claro">
      <span className="sp-switch-knob">
        <svg className="luna" viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /></svg>
        <svg className="sol" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
      </span>
    </button>
  );
}

// Las tarjetas glass se tiñen donde está el cursor
const TARJETAS = ".sp-card, .sp-kpi, .lp-card, .el-card";
export function brillo(e) {
  if (e.pointerType !== "mouse") return;
  const t = e.target.closest?.(TARJETAS);
  if (!t) return;
  const r = t.getBoundingClientRect();
  t.style.setProperty("--mx", `${e.clientX - r.left}px`);
  t.style.setProperty("--my", `${e.clientY - r.top}px`);
}

/* ── Segmentado con indicador deslizante. options: [{ v, t }] ── */
export function Pills({ value, onChange, options, label }) {
  const ref = useRef(null);
  const [ind, setInd] = useState(null);
  useLayoutEffect(() => {
    const medir = () => {
      const b = ref.current?.querySelector("button.on");
      if (b) setInd({ left: b.offsetLeft, top: b.offsetTop, width: b.offsetWidth, height: b.offsetHeight });
    };
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [value, options.length]);
  return (
    <div className="sp-pills" role="tablist" aria-label={label} ref={ref}>
      {ind && <span className="sp-pill-ind" style={ind} aria-hidden="true" />}
      {options.map((o) => (
        <button key={o.v} role="tab" aria-selected={o.v === value} className={o.v === value ? "on" : ""} onClick={() => onChange(o.v)}>{o.t}</button>
      ))}
    </div>
  );
}

/* ── Panel de filtros (Filtros.jsx): un glass, cada filtro con su nombre arriba ── */
export function Filtros({ children, onLimpiar, acciones }) {
  return (
    <div className="nk-filtros" role="group" aria-label="Filtros">
      {children}
      {(onLimpiar || acciones) && (
        <div className="nk-acciones">
          {acciones}
          {onLimpiar && (
            <button className="nk-limpiar" onClick={onLimpiar}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4" /></svg>Limpiar filtros
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function Filtro({ etiqueta, children }) {
  return (
    <div className="nk-f">
      <span className="nk-f-l">{etiqueta}</span>
      <div className="nk-f-c">{children}</div>
    </div>
  );
}

// Menú desplegable propio. opciones: [{ v, t }]
export function Menu({ valor, onChange, opciones, aria }) {
  const [abierto, setAbierto] = useState(false);
  const [izq, setIzq] = useState(false);
  const ref = useRef(null);
  const lista = useRef(null);
  // Abre alineado a la derecha del botón; si así se sale de la pantalla, se alinea a la izquierda
  useLayoutEffect(() => {
    if (abierto && !izq && lista.current && lista.current.getBoundingClientRect().left < 8) setIzq(true); // eslint-disable-line react-hooks/set-state-in-effect
  }, [abierto, izq]);
  useEffect(() => {
    if (!abierto) return;
    const fuera = (e) => { if (!ref.current?.contains(e.target)) setAbierto(false); };
    const esc = (e) => { if (e.key === "Escape") setAbierto(false); };
    document.addEventListener("pointerdown", fuera);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", fuera); document.removeEventListener("keydown", esc); };
  }, [abierto]);
  const actual = opciones.find((o) => o.v === valor) || opciones[0];
  const elegir = (v) => { onChange(v); setAbierto(false); };
  return (
    <div className={`md-menu ${abierto ? "abierto" : ""}`} ref={ref}>
      <button className="md-menu-btn" onClick={() => { setIzq(false); setAbierto((x) => !x); }} aria-haspopup="listbox" aria-expanded={abierto} aria-label={aria ? `${aria}: ${actual.t}` : undefined}>
        <b>{actual.t}</b>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {abierto && (
        <ul ref={lista} className={`md-menu-lista ${izq ? "izq" : ""}`} role="listbox" aria-label={aria}>
          {opciones.map((o) => (
            <li key={o.v} role="option" aria-selected={o.v === valor} className={o.v === valor ? "on" : ""} tabIndex={0}
              onClick={() => elegir(o.v)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); elegir(o.v); } }}>
              {o.t}
              {o.v === valor && <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Sel({ label, value, onChange, options }) {
  return <Filtro etiqueta={label}><Menu aria={label} valor={value} onChange={onChange} opciones={options} /></Filtro>;
}

// Buscador de Tiendas Bara (sin debounce: la app ya filtra en memoria al escribir)
export function Buscador({ value, onChange, etiqueta, placeholder = "Buscar…", aria }) {
  return (
    <Filtro etiqueta={etiqueta}>
      <input className="pw-input ba-input" value={value} placeholder={placeholder} aria-label={aria || etiqueta} onChange={(e) => onChange(e.target.value)} />
      {value && <button className="ba-x" aria-label="Borrar búsqueda" onClick={() => onChange("")}>×</button>}
    </Filtro>
  );
}
