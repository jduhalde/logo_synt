import { useState, useEffect, useMemo, useRef } from 'react'
import Papa from 'papaparse'
import jsPDF from 'jspdf'
import html2canvas from 'html2canvas'
import {
  BarChart, Bar, AreaChart, Area, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  ReferenceLine, ReferenceArea
} from 'recharts'
import {
  calcAllYears, getEffectiveParams, getProjectFaseByYear,
  H_MIN, H_MAX
} from './utils/calcEngine'

const SHEET_ID = '2PACX-1vTSHn-Vj56pLdp0PqmzFjVftKNH4TdYGO3Hwb8idjWekAG2phBp1pvxg729UDEQhiCMHRX6a4PyGouU'
const GID = {
  PROYECTOS:          '0',
  PARAMETROS_GRUPO:   '1492485662',
  CURVAS_PERFIL:      '1465342853',
  FLUJOS_PROYECTO:    '1025982336',
  PRECIOS_REFERENCIA: '1329487708',
}

const _NOW        = new Date()
const TODAY       = _NOW.getFullYear()
const TODAY_FRAC  = TODAY + _NOW.getMonth() / 12
const TODAY_LABEL = _NOW.toLocaleDateString('es-AR', { month: 'short', year: 'numeric' })
const mkUrl = gid =>
  `https://docs.google.com/spreadsheets/d/e/${SHEET_ID}/pub?gid=${gid}&single=true&output=csv`

const GC = { cobre: '#0284c7', litio: '#059669', oro_plata: '#d97706', otros: '#6b7280' }
const GL = { cobre: 'Cobre', litio: 'Litio', oro_plata: 'Oro/Plata', otros: 'Otros' }
const GRUPOS = ['cobre', 'litio', 'oro_plata', 'otros']

const ESTADO_COLOR = {
  'Exploración Inicial':  '#FCD34D',
  'Exploración Avanzada': '#F97316',
  'Prospección':          '#A78BFA',
  'P.E.A.':               '#38BDF8',
  'Prefactibilidad':      '#86EFAC',
  'Factibilidad':         '#22C55E',
  'Construcción':         '#2563EB',
  'Producción':           '#15803D',
  'Ampliación':           '#4ADE80',
  'Reingeniería':         '#F472B6',
  'Mantenimiento':        '#60A5FA',
  'Suspendido':           '#EF4444',
}

const FASE_COLOR = {
  construccion: '#2563EB',
  ramp_up:      '#F59E0B',
  operacion:    '#15803D',
  cierre:       '#9CA3AF',
}
const FASE_LABEL = {
  construccion: 'Construcción',
  ramp_up:      'Ramp-up',
  operacion:    'Operación',
  cierre:       'Cierre',
}

const pN = v => parseFloat(String(v || '0').replace(',', '.')) || 0

const fmt$ = n =>
  n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` :
  n >= 1e6 ? `$${(n / 1e6).toFixed(0)}M` : `$${Math.round(n).toLocaleString()}`

const fmtK = n =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` :
  n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : Math.round(n).toLocaleString()

const fetchCSV = url => new Promise((res, rej) =>
  Papa.parse(url, {
    download: true, header: true, skipEmptyLines: true,
    complete: r => res(r.data), error: rej
  })
)

// ── PDF ───────────────────────────────────────────────

async function generatePDF(proyectos, añosInicio, enabled, totals, paramsMap, horizon, precios, chartsRef) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  const W = 287

  // Minerales activos en la selección actual
  const mineralesActivos = [...new Set(proyectos.map(p => p.precio_serie).filter(Boolean))]
  const gruposActivos    = [...new Set(proyectos.map(p => p.grupo).filter(Boolean))]

  // ── Utilidades ──────────────────────────────────────
  const addPageHeader = (titulo = 'Impacto Económico — Cartera Minera Argentina') => {
    doc.setFillColor(2,132,199); doc.rect(0,0,W+10,2,'F')
    doc.setFillColor(248,250,252); doc.rect(0,2,W+10,14,'F')
    doc.setFontSize(12); doc.setFont('helvetica','bold'); doc.setTextColor(30,58,138)
    doc.text(titulo, 8, 12)
    doc.setFontSize(7.5); doc.setFont('helvetica','normal'); doc.setTextColor(148,163,184)
    doc.text(`${TODAY_LABEL}  ·  Horizonte ${horizon}`, W-5, 12, { align:'right' })
    doc.setDrawColor(226,232,240); doc.line(0,16,W+10,16)
  }

  const sectionTitle = (txt, y) => {
    doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.setTextColor(30,58,138)
    doc.text(txt, 5, y)
    doc.setDrawColor(2,132,199); doc.line(5, y+1.5, 5+doc.getTextWidth(txt), y+1.5)
    doc.setFont('helvetica','normal')
    return y + 7
  }

  const tblHead = (cols, widths, aligns, y, bgR=2, bgG=132, bgB=199) => {
    doc.setFillColor(bgR,bgG,bgB); doc.rect(5,y-5,W,7,'F')
    doc.setFontSize(7.5); doc.setFont('helvetica','bold'); doc.setTextColor(255,255,255)
    let x=7
    cols.forEach((h,i)=>{
      if (aligns[i]==='right') doc.text(h, x+widths[i]-2, y, {align:'right'})
      else doc.text(h, x+1, y)
      x+=widths[i]
    })
    doc.setFont('helvetica','normal')
    return y+5
  }

  const tblRow = (vals, widths, aligns, y, idx, textColors=null) => {
    doc.setFillColor(idx%2===0 ? 248 : 255, idx%2===0 ? 250 : 255, idx%2===0 ? 252 : 255)
    doc.rect(5,y-4,W,6.5,'F')
    doc.setDrawColor(230,234,238); doc.line(5,y+2.5,W+5,y+2.5)
    doc.setFontSize(7.5)
    let x=7
    vals.forEach((v,i)=>{
      const c = textColors?.[i] || [30,41,59]
      doc.setTextColor(...c)
      if (aligns[i]==='right') doc.text(String(v), x+widths[i]-2, y, {align:'right'})
      else doc.text(String(v), x+1, y)
      x+=widths[i]
    })
  }

  const newPage = (titulo) => { doc.addPage(); addPageHeader(titulo); return 24 }

  const GC_PDF = { cobre:[2,132,199], litio:[5,150,105], oro_plata:[217,119,6], otros:[107,114,128] }

  // ── PORTADA ─────────────────────────────────────────
  doc.setFillColor(15,23,42); doc.rect(0,0,W+10,210,'F')
  doc.setFillColor(2,132,199); doc.rect(0,0,W+10,3,'F')

  doc.setFontSize(22); doc.setFont('helvetica','bold'); doc.setTextColor(255,255,255)
  doc.text('Impacto Económico', 16, 45)
  doc.text('Cartera Minera Argentina', 16, 58)

  doc.setFontSize(11); doc.setFont('helvetica','normal'); doc.setTextColor(148,163,184)
  doc.text(`Horizonte ${TODAY_LABEL} — ${horizon}  ·  ${proyectos.length} proyecto${proyectos.length!==1?'s':''} seleccionado${proyectos.length!==1?'s':''}`, 16, 70)

  // Lista de proyectos por grupo en portada
  let py = 85
  const grupos = ['cobre','litio','oro_plata','otros'].filter(g => gruposActivos.includes(g))
  grupos.forEach(g => {
    const gps = proyectos.filter(p => p.grupo === g)
    if (!gps.length) return
    const [r,gg,b] = GC_PDF[g]
    doc.setFillColor(r,gg,b); doc.rect(16,py-3.5,2,gps.length*6+2,'F')
    doc.setFontSize(8); doc.setFont('helvetica','bold'); doc.setTextColor(r,gg,b)
    doc.text(GL[g].toUpperCase(), 22, py)
    py += 5.5
    gps.forEach(p => {
      doc.setFontSize(7.5); doc.setFont('helvetica','normal'); doc.setTextColor(203,213,225)
      doc.text(`${p.nombre}  ·  ${p.empresa||''}  ·  ${p.estado||''}`, 22, py)
      py += 5.5
    })
    py += 3
  })

  doc.setFontSize(6.5); doc.setTextColor(71,85,105)
  doc.text('Fuente de proyecciones: Dirección Nacional de Promoción y Economía Minera, Secretaría de Minería, Abr 2026.', 16, 195)
  doc.text('Datos estimados señalados en la planilla de datos. Todo lo proyectado son estimaciones — no datos confirmados.', 16, 200)

  // ── PÁGINA 1: KPIs + Proyectos ───────────────────────
  doc.addPage(); addPageHeader()

  const peak      = totals.reduce((mx,t)=>t.empTot>(mx?.empTot||0)?t:mx, null)
  const sumInv    = totals.reduce((s,t)=>s+t.inv, 0)
  const peakVal   = totals.reduce((mx,t)=>t.valor>mx?t.valor:mx, 0)
  const sumInsNac = totals.reduce((s,t)=>s+t.insNac, 0)
  const sumInsImp = totals.reduce((s,t)=>s+t.insImp, 0)

  const kpis = [
    { l:'Inversión total acumulada',   v:fmt$(sumInv),                                     r:2,  g:132,b:199 },
    { l:'Pico de empleo (dir.+ind.)',  v:peak?`${fmtK(peak.empTot)}  ·  ${peak.año}`:'—', r:5,  g:150,b:105 },
    { l:'Valor producción pico anual', v:fmt$(peakVal),                                    r:217,g:119,b:6   },
    { l:'Insumos nacionales acum.',    v:fmt$(sumInsNac),                                  r:124,g:58, b:237  },
    { l:'Insumos importados acum.',    v:fmt$(sumInsImp),                                  r:220,g:38, b:38   },
  ]
  kpis.forEach(({l,v,r,g,b},i) => {
    const kx=5+(i%3)*95, ky=20+Math.floor(i/3)*22
    doc.setFillColor(255,255,255); doc.rect(kx,ky-5,91,19,'F')
    doc.setDrawColor(226,232,240); doc.rect(kx,ky-5,91,19,'S')
    doc.setFillColor(r,g,b);      doc.rect(kx,ky-5,2,19,'F')
    doc.setFontSize(7);  doc.setTextColor(100,116,139); doc.text(l, kx+5, ky+1)
    doc.setFontSize(14); doc.setFont('helvetica','bold'); doc.setTextColor(r,g,b)
    doc.text(v, kx+5, ky+11)
    doc.setFont('helvetica','normal')
  })

  doc.setFontSize(6.5); doc.setTextColor(148,163,184)
  doc.text(`Nota: todo lo proyectado a partir de ${TODAY_LABEL} son anuncios o estimaciones — no datos confirmados.`, 5, 64)

  let y = sectionTitle('Parámetros por proyecto seleccionado', 71)

  const pCols  = ['Proyecto','Empresa','Provincia','Grupo','Estado','Inicio','Prod.','Cierre','Inversión','Prod./año','Unidad','V.útil']
  const pW     = [46,30,22,16,24,13,13,13,22,22,14,14]
  const pAlign = ['left','left','left','left','left','right','right','right','right','right','left','right']

  y = tblHead(pCols, pW, pAlign, y)

  proyectos.forEach((p,idx) => {
    if (y>196) { y=newPage(); y=tblHead(pCols,pW,pAlign,y) }
    const pm  = paramsMap[p.grupo]
    const ep  = pm?getEffectiveParams(p,pm):{}
    const año = añosInicio[p.nombre]??pN(p.anio_inicio_default)
    const prod= año+(ep.dC||0)
    const fin = prod+(ep.dR||0)+(ep.vU||0)+(ep.dCi||0)
    const [gr,gg,gb] = GC_PDF[p.grupo]||[107,114,128]

    tblRow([
      p.nombre.substring(0,24),
      (p.empresa||'').substring(0,15),
      (p.provincia||'').substring(0,11),
      (GL[p.grupo]||p.grupo).substring(0,8),
      (p.estado||'—').substring(0,13),
      año, prod, fin,
      `${(+p.inversion_mmusd).toLocaleString()}M`,
      (+p.produccion_fisica_anual).toLocaleString(),
      (p.unidad_produccion||'').substring(0,7),
      `${ep.vU||'—'} a.`
    ], pW, pAlign, y, idx,
    [[gr,gg,gb],[71,85,105],[71,85,105],[gr,gg,gb],[71,85,105],
     [30,41,59],[30,41,59],[30,41,59],[30,41,59],[30,41,59],[71,85,105],[30,41,59]])

    doc.setFillColor(gr,gg,gb); doc.rect(5,y-3.5,1.5,5,'F')
    y+=6.5
  })

  // ── PÁGINA 2: Flujos anuales ─────────────────────────
  y = newPage()
  y = sectionTitle('Flujos anuales agregados — proyectos seleccionados (USD millones)', y)

  // Columnas dinámicas según grupos activos
  const fCols = ['Año','Total Inv','Total Val','Emp.C','Emp.O','Emp.Tot','InsNac$M','InsImp$M']
  const fW    = [14,20,20,16,16,18,20,20]
  if (gruposActivos.includes('cobre'))    { fCols.splice(2,0,'Cob.Inv','Cob.Val'); fW.splice(2,0,16,16) }
  if (gruposActivos.includes('litio'))    { fCols.splice(gruposActivos.includes('cobre')?4:2,0,'Lit.Inv','Lit.Val'); fW.splice(gruposActivos.includes('cobre')?4:2,0,16,16) }
  if (gruposActivos.includes('oro_plata')){ fCols.splice(-6,0,'Oro.Inv','Oro.Val'); fW.splice(-6,0,16,16) }
  const fAlign = fCols.map((_,i)=>i===0?'left':'right')

  y = tblHead(fCols, fW, fAlign, y)

  totals.filter(t=>t.año>=2025&&t.año<=horizon&&(t.inv>0||t.valor>0||t.empTot>0))
    .forEach((t,idx)=>{
      if (y>196) { y=newPage(); y=tblHead(fCols,fW,fAlign,y) }
      const isNow=t.año===TODAY
      if (isNow) { doc.setFillColor(254,242,242); doc.rect(5,y-4,W,6.5,'F') }
      doc.setFont('helvetica',isNow?'bold':'normal')

      const vals = [String(t.año), t.inv>0?String(Math.round(t.inv/1e6)):'', t.valor>0?String(Math.round(t.valor/1e6)):'']
      if (gruposActivos.includes('cobre'))    vals.splice(2,0, t.g.cobre.inv>0?String(Math.round(t.g.cobre.inv/1e6)):'', t.g.cobre.valor>0?String(Math.round(t.g.cobre.valor/1e6)):'')
      if (gruposActivos.includes('litio'))    vals.splice(gruposActivos.includes('cobre')?4:2,0, t.g.litio.inv>0?String(Math.round(t.g.litio.inv/1e6)):'', t.g.litio.valor>0?String(Math.round(t.g.litio.valor/1e6)):'')
      if (gruposActivos.includes('oro_plata'))vals.splice(-6,0, t.g.oro_plata.inv>0?String(Math.round(t.g.oro_plata.inv/1e6)):'', t.g.oro_plata.valor>0?String(Math.round(t.g.oro_plata.valor/1e6)):'')
      vals.push(t.empC>0?fmtK(t.empC):'', t.empO>0?fmtK(t.empO):'', t.empTot>0?fmtK(t.empTot):'',
                t.insNac>0?String(Math.round(t.insNac/1e6)):'', t.insImp>0?String(Math.round(t.insImp/1e6)):'')

      tblRow(vals, fW, fAlign, y, idx,
        fCols.map((_,i)=> i===0?(isNow?[220,38,38]:[30,41,59]):[71,85,105]))
      doc.setFont('helvetica','normal')
      y+=6.5
    })

  // ── PÁGINA 3: Impacto económico (Schteingart-Maito) ──
  y = newPage()
  y = sectionTitle('Estimación de impacto económico — descomposición del valor bruto de producción', y)

  // Usar el año pico de valor dentro del horizonte
  const peakTot = totals.filter(t=>t.año<=horizon).reduce((mx,t)=>t.valor>mx.valor?t:mx, {valor:0,año:0})
  const vbp = peakTot.valor / 1e6  // en MM USD

  doc.setFontSize(7.5); doc.setFont('helvetica','normal'); doc.setTextColor(71,85,105)
  doc.text(`Proyección para año pico de valor: ${peakTot.año}  ·  VBP estimado: ${fmt$(peakTot.valor)}`, 5, y)
  doc.text('Metodología: Schteingart y Maito (2022) con base en ENGE-INDEC 2017-2019. Referencia: DNPyEM, Secretaría de Minería, Abril 2026.', 5, y+5)
  y += 13

  const impRows = [
    { cat:'GASTOS LOCALES', pct:67.0, bold:true, color:[2,132,199] },
    { cat:'  Consumo intermedio nacional (neto de importaciones)', pct:29.8, bold:false, color:[71,85,105] },
    { cat:'  Salarios', pct:12.5, bold:false, color:[71,85,105] },
    { cat:'  Amortizaciones nacionales (neto)', pct:10.6, bold:false, color:[71,85,105] },
    { cat:'  Impuesto a las ganancias', pct:4.7, bold:false, color:[71,85,105] },
    { cat:'  Regalías y fideicomisos', pct:3.6, bold:false, color:[71,85,105] },
    { cat:'  Impuestos a la producción (netos de subsidios)', pct:3.1, bold:false, color:[71,85,105] },
    { cat:'  Contribuciones a la seguridad social', pct:2.7, bold:false, color:[71,85,105] },
    { cat:'GASTOS A NO RESIDENTES', pct:20.2, bold:true, color:[220,38,38] },
    { cat:'  Dividendos', pct:5.2, bold:false, color:[71,85,105] },
    { cat:'  Consumo intermedio importado', pct:4.2, bold:false, color:[71,85,105] },
    { cat:'  Contenido importado en CI nacional', pct:3.2, bold:false, color:[71,85,105] },
    { cat:'  Intereses', pct:3.2, bold:false, color:[71,85,105] },
    { cat:'  Amortizaciones importadas', pct:3.1, bold:false, color:[71,85,105] },
    { cat:'  Contenido importado en amortizaciones', pct:1.2, bold:false, color:[71,85,105] },
    { cat:'INGRESO NETO DISPONIBLE', pct:12.9, bold:true, color:[124,58,237] },
  ]

  const iCols  = ['Componente', '%', `USD M (est. año ${peakTot.año})`]
  const iW     = [190, 30, 57]
  const iAlign = ['left','right','right']
  y = tblHead(iCols, iW, iAlign, y)

  impRows.forEach((row,idx)=>{
    if (y>196) { y=newPage(); y=tblHead(iCols,iW,iAlign,y) }
    doc.setFont('helvetica', row.bold?'bold':'normal')
    if (row.bold) { doc.setFillColor(240,245,255); doc.rect(5,y-4,W,6.5,'F') }
    tblRow([
      row.cat,
      `${row.pct.toFixed(1)}%`,
      Math.round(vbp * row.pct / 100).toLocaleString()
    ], iW, iAlign, y, idx,
    [row.color, row.color, row.color])
    doc.setFont('helvetica','normal')
    y+=6.5
  })

  y+=4
  doc.setFontSize(6.5); doc.setTextColor(148,163,184)
  doc.text('Los porcentajes corresponden al escenario histórico 2017-2019 (ENGE-INDEC). Pueden diferir según la composición específica de la cartera seleccionada.', 5, y)
  doc.text('El ingreso neto disponible puede reinvertirse localmente o remitirse al exterior según estrategia de cada empresa.', 5, y+4.5)

  // ── PÁGINA 4: Precios (solo minerales activos) ────────
  y = newPage()
  const minLabel = { cobre:'Cobre (USD/t)', litio:'Litio (USD/t LCE)', oro:'Oro (USD/oz)', plata:'Plata (USD/oz)' }
  const minColor = { cobre:[2,132,199], litio:[5,150,105], oro:[217,119,6], plata:[107,114,128] }
  const minCols  = mineralesActivos.filter(m => minLabel[m])

  y = sectionTitle(`Precios de referencia — ${minCols.map(m=>minLabel[m]).join(' · ')}`, y)

  const prW     = [16, ...minCols.map(() => Math.floor((W-16-10) / minCols.length))]
  const prCols  = ['Año', ...minCols.map(m=>minLabel[m])]
  const prAlign = prCols.map((_,i) => i===0?'left':'right')
  y = tblHead(prCols, prW, prAlign, y)

  for (let yr=2025; yr<=horizon; yr++) {
    if (y>196) { y=newPage(); y=tblHead(prCols,prW,prAlign,y) }
    const isNow=yr===TODAY
    if (isNow) { doc.setFillColor(254,242,242); doc.rect(5,y-4,W,6.5,'F') }
    doc.setFont('helvetica',isNow?'bold':'normal')
    const vals = minCols.map(m => {
      const row=precios.find(p=>p.mineral===m&&pN(p.año)===yr)
      return row?Number(pN(row.precio_usd)).toLocaleString('es-AR'):'—'
    })
    tblRow([String(yr),...vals], prW, prAlign, y, (yr-2025),
      [isNow?[220,38,38]:[30,41,59], ...minCols.map(m=>minColor[m]||[71,85,105])])
    doc.setFont('helvetica','normal')
    y+=6.5
  }

  if (y>185) { y=newPage() }
  doc.setFontSize(6.5); doc.setTextColor(148,163,184)
  doc.text('Promedios 2026-2036 adoptados (Sec.Minería Abr 2026): Cobre USD/t 10.768 · Litio USD/t LCE 13.228 · Oro USD/oz 3.782 · Plata USD/oz 40,02.', 5, y+8)
  doc.text('Precios 2041-2075 son estimaciones de largo plazo de alta incertidumbre. Actualizables en PRECIOS_REFERENCIA.', 5, y+13)

  // ── PÁGINA 5: Gráficos del dashboard ─────────────────
  if (chartsRef?.current) {
    try {
      await new Promise(r => setTimeout(r, 800)) // esperar render de Recharts
      const canvas = await html2canvas(chartsRef.current, {
        scale: 1.5,
        backgroundColor: '#f9fafb',
        useCORS: true,
        logging: false,
        windowWidth: 1280,
      })
      const imgData = canvas.toDataURL('image/png')
      const imgW = W - 10
      const imgH = (canvas.height / canvas.width) * imgW

      doc.addPage(); addPageHeader()
      let yc = sectionTitle('Visualizaciones del dashboard — proyectos seleccionados', 24)

      if (imgH <= 175) {
        doc.addImage(imgData, 'PNG', 5, yc, imgW, imgH)
      } else {
        // Partir en dos mitades
        doc.addImage(imgData, 'PNG', 5, yc, imgW, imgH * 0.5, '', 'FAST', 0)
        doc.addPage(); addPageHeader(); yc = 22
        doc.addImage(imgData, 'PNG', 5, yc, imgW, imgH * 0.5, '', 'FAST', 0)
      }
    } catch (e) {
      console.warn('No se pudo capturar los gráficos:', e)
    }
  }

  doc.save(`impacto-minero-${proyectos.length}proy-${TODAY}.pdf`)
}

// ── YearSlider ────────────────────────────────────────

function YearSlider({ value, onChange, disabled, color }) {
  const years = [2025,2026,2027,2028,2029,2030,2031,2032,2033,2034,2035,2036,2037,2038,2039,2040]
  const pct = (value - 2025) / 15 * 100
  return (
    <div className="w-full">
      <div className="relative mb-1">
        <input type="range" min={2025} max={2040} value={value}
          onChange={e => onChange(+e.target.value)}
          disabled={disabled}
          className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
          style={{ accentColor: color }} />
        <div className="absolute -top-5 text-xs font-bold pointer-events-none"
          style={{ left:`calc(${pct}% - 10px)`, color }}>
          {value}
        </div>
      </div>
      <div className="relative w-full h-5">
        {years.map((y, i) => {
          const left = `${i / 15 * 100}%`
          const active = y === value
          const isMajor = y % 5 === 0
          return (
            <div key={y} className={`absolute flex flex-col items-center ${!isMajor ? 'hidden sm:flex' : ''}`}
              style={{ left, transform:'translateX(-50%)' }}>
              <div className={`w-px ${active ? 'h-2 bg-gray-900' : 'h-1.5 bg-gray-500'}`} />
              {isMajor
                ? <span className={`text-xs leading-none mt-0.5 ${active ? 'font-bold text-gray-900' : 'text-gray-600'}`}>{y}</span>
                : <span className="text-xs leading-none mt-0.5 text-gray-400 hidden sm:inline">·</span>
              }
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Componentes base ──────────────────────────────────

function KpiCard({ title, value, sub, accent = '#0284c7' }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="text-xs text-gray-500 mb-1">{title}</div>
      <div className="text-2xl font-bold text-gray-900">{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
      <div className="h-0.5 rounded-full mt-3" style={{ background: accent }} />
    </div>
  )
}

function ChartCard({ title, sub, children }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="mb-3">
        <div className="font-medium text-gray-800 text-sm">{title}</div>
        {sub && <div className="text-xs text-gray-400">{sub}</div>}
      </div>
      <ResponsiveContainer width="100%" height={220}>{children}</ResponsiveContainer>
    </div>
  )
}

// ── App ───────────────────────────────────────────────

export default function App() {
  const [data, setData] = useState({ proyectos: [], params: [], curvas: [], flujos: [], precios: [] })
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [tab, setTab] = useState('proyectos')
  const [añosInicio, setAñosInicio] = useState({})
  const [defaultAños, setDefaultAños] = useState({})
  const [enabled, setEnabled] = useState({})
  const chartsRef = useRef(null)
  const [horizon, setHorizon] = useState(2050)

  useEffect(() => {
    Promise.all([
      fetchCSV(mkUrl(GID.PROYECTOS)),
      fetchCSV(mkUrl(GID.PARAMETROS_GRUPO)),
      fetchCSV(mkUrl(GID.CURVAS_PERFIL)),
      fetchCSV(mkUrl(GID.FLUJOS_PROYECTO)),
      fetchCSV(mkUrl(GID.PRECIOS_REFERENCIA)),
    ]).then(([proyectos, params, curvas, flujos, precios]) => {
      const flFilt = flujos.filter(r =>
        r.proyecto && r.año_calendario && !r.proyecto.startsWith('INSTRUCCIONES'))
      setData({ proyectos, params, curvas, flujos: flFilt, precios })
      const iA = {}, iE = {}
      proyectos.forEach(p => { iA[p.nombre] = +p.anio_inicio_default; iE[p.nombre] = true })
      setAñosInicio(iA); setDefaultAños({...iA}); setEnabled(iE)
      setLoading(false)
    }).catch(e => { setErr(e.message); setLoading(false) })
  }, [])

  const paramsMap = useMemo(() =>
    Object.fromEntries(data.params.map(p => [p.grupo, p])), [data.params])

  const activos = useMemo(() =>
    data.proyectos.filter(p => enabled[p.nombre] !== false),
    [data.proyectos, enabled])

  const totals = useMemo(() => {
    if (!activos.length || !data.curvas.length) return []
    return calcAllYears(activos, paramsMap, data.curvas, data.flujos, data.precios, añosInicio)
  }, [activos, paramsMap, data.curvas, data.flujos, data.precios, añosInicio])

  const chartData = useMemo(() =>
    totals.filter(t => t.año >= 2025 && t.año <= horizon).map(t => ({
      año: t.año,
      cobre_inv: +(t.g.cobre.inv / 1e6).toFixed(0),
      litio_inv:  +(t.g.litio.inv / 1e6).toFixed(0),
      oro_inv:    +(t.g.oro_plata.inv / 1e6).toFixed(0),
      otros_inv:  +(t.g.otros.inv / 1e6).toFixed(0),
      cobre_val:  +(t.g.cobre.valor / 1e6).toFixed(0),
      litio_val:  +(t.g.litio.valor / 1e6).toFixed(0),
      oro_val:    +(t.g.oro_plata.valor / 1e6).toFixed(0),
      otros_val:  +(t.g.otros.valor / 1e6).toFixed(0),
      empC: +t.empC.toFixed(0),
      empO: +t.empO.toFixed(0),
      insNac: +(t.insNac / 1e6).toFixed(0),
      insImp: +(t.insImp / 1e6).toFixed(0),
    })),
    [totals, horizon])

  const peak      = useMemo(() => totals.reduce((mx,t) => t.empTot>(mx?.empTot||0)?t:mx, null), [totals])
  const sumInv    = useMemo(() => totals.reduce((s,t) => s+t.inv, 0), [totals])
  const peakVal   = useMemo(() => totals.reduce((mx,t) => t.valor>mx?t.valor:mx, 0), [totals])
  const sumInsNac = useMemo(() => totals.reduce((s,t) => s+t.insNac, 0), [totals])

  const isModified = useMemo(() =>
    Object.keys(defaultAños).some(n => añosInicio[n] !== defaultAños[n]),
    [añosInicio, defaultAños])

  const resetToDefault = () => setAñosInicio({...defaultAños})

  const TABS = [
    { id: 'proyectos',   label: 'Proyectos' },
    { id: 'gantt',       label: 'Gantt' },
    { id: 'dashboard',   label: 'Dashboard' },
    { id: 'metodologia', label: 'Metodología' },
  ]

  if (loading) return (
    <div className="h-screen flex items-center justify-center">
      <div className="text-center text-gray-500">
        <div className="text-3xl mb-3">⏳</div>
        <div className="text-sm">Cargando datos desde la sheet...</div>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-gray-900 text-white px-4 py-3 shadow">
        <div className="max-w-7xl mx-auto">
          <div className="flex items-center justify-between mb-2">
            <div>
              <h1 className="text-sm font-semibold tracking-tight leading-tight">
                Impacto Económico — Cartera Minera Argentina
              </h1>
              <p className="text-xs text-gray-400 mt-0.5 hidden sm:block">RIGI · Proyecciones {TODAY}–{H_MAX}</p>
            </div>
            <button
              onClick={() => generatePDF(activos, añosInicio, enabled, totals, paramsMap, horizon, data.precios, chartsRef)}
              className="text-xs px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-medium transition-colors flex-shrink-0 ml-3">
              ↓ PDF
            </button>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-gray-400 text-xs">
              {activos.length}/{data.proyectos.length} proyectos
            </span>
            {isModified && (
              <span className="flex items-center gap-1 text-xs bg-amber-500 text-white px-2 py-0.5 rounded-lg">
                ⚡ Simulación
              </span>
            )}
            {isModified && (
              <button onClick={resetToDefault}
                className="text-xs px-2 py-0.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-white transition-colors">
                ↺ Restablecer
              </button>
            )}
            <div className="flex items-center gap-1.5 ml-auto">
              <span className="text-gray-400 text-xs">Hasta:</span>
              <select value={horizon} onChange={e => setHorizon(+e.target.value)}
                className="bg-gray-800 text-white text-xs rounded px-2 py-1 border border-gray-700">
                {[2030, 2035, 2040, 2050, 2060, 2075].map(y =>
                  <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
          </div>
        </div>
      </header>

      <div className="bg-white border-b border-gray-200 sticky top-0 z-10 overflow-x-auto">
        <div className="max-w-7xl mx-auto px-4 flex min-w-max sm:min-w-0">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-3 sm:px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap
                ${tab === t.id
                  ? 'border-sky-600 text-sky-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <main className="max-w-7xl mx-auto px-3 sm:px-6 py-4 sm:py-6">
        {err && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6 text-sm text-red-700">
            ⚠️ Error al cargar: {err}
          </div>
        )}
        {tab === 'proyectos' && (
          <TabProyectos
            proyectos={data.proyectos} paramsMap={paramsMap}
            añosInicio={añosInicio} setAñosInicio={setAñosInicio}
            enabled={enabled} setEnabled={setEnabled}
          />
        )}
        {tab === 'gantt' && (
          <TabGantt
            proyectos={data.proyectos} paramsMap={paramsMap}
            flujos={data.flujos}
            añosInicio={añosInicio} setAñosInicio={setAñosInicio}
            defaultAños={defaultAños}
            enabled={enabled}
            totals={totals} horizon={horizon}
          />
        )}
        <div style={tab !== 'dashboard' ? { position:'absolute', left:'-9999px', top:'-9999px', width:'1280px' } : {}}>
  <TabDashboard
    kpis={{ sumInv, peak, peakVal, sumInsNac }}
    chartData={chartData}
    chartsRef={chartsRef}
  />
</div>
        {tab === 'metodologia' && <TabMetodologia />}
      </main>
    </div>
  )
}

// ── TAB PROYECTOS ─────────────────────────────────────

function TabProyectos({ proyectos, paramsMap, añosInicio, setAñosInicio, enabled, setEnabled }) {
  const grupos = GRUPOS.filter(g => proyectos.some(p => p.grupo === g))
  const toggleAll = val => {
    const next = {}
    proyectos.forEach(p => { next[p.nombre] = val })
    setEnabled(next)
  }
  return (
    <div>
      <div className="flex gap-2 mb-5">
        <button onClick={() => toggleAll(true)}
          className="text-xs px-3 py-1.5 rounded-lg bg-white border border-gray-200 hover:bg-gray-50 text-gray-700">
          Activar todos
        </button>
        <button onClick={() => toggleAll(false)}
          className="text-xs px-3 py-1.5 rounded-lg bg-white border border-gray-200 hover:bg-gray-50 text-gray-700">
          Desactivar todos
        </button>
      </div>
      {grupos.map(g => {
        const gps = proyectos.filter(p => p.grupo === g)
        return (
          <div key={g} className="mb-7">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-2.5 h-2.5 rounded-full" style={{ background: GC[g] }} />
              <h2 className="font-semibold text-gray-700 text-xs uppercase tracking-widest">{GL[g]}</h2>
              <span className="text-xs text-gray-400">({gps.length})</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {gps.map(p => (
                <ProjectCard key={p.nombre} p={p} params={paramsMap[p.grupo]}
                  año={añosInicio[p.nombre] ?? +p.anio_inicio_default}
                  on={enabled[p.nombre] !== false}
                  onAño={v => setAñosInicio(prev => ({ ...prev, [p.nombre]: v }))}
                  onToggle={v => setEnabled(prev => ({ ...prev, [p.nombre]: v }))}
                />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ProjectCard({ p, params, año, on, onAño, onToggle }) {
  const ep = params ? getEffectiveParams(p, params) : {}
  const color = GC[p.grupo] || GC.otros
  const estadoColor = ESTADO_COLOR[p.estado] || '#9CA3AF'
  const prodInicio = año + (ep.dC || 0)
  const finProyecto = prodInicio + (ep.dR || 0) + (ep.vU || 0) + (ep.dCi || 0)
  const rigi = p.notas?.toLowerCase().includes('rigi aprobado')
  return (
    <div className={`rounded-xl border bg-white p-4 transition-opacity ${!on ? 'opacity-45' : ''}`}>
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-1 flex-wrap">
            <span className="text-white text-xs px-2 py-0.5 rounded-full font-medium"
              style={{ background: color }}>{p.mineral || p.grupo}</span>
            {p.estado && (
              <span className="text-white text-xs px-2 py-0.5 rounded-full font-medium"
                style={{ background: estadoColor }}>{p.estado}</span>
            )}
            {rigi && (
              <span className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded-full">
                RIGI ✓
              </span>
            )}
          </div>
          <h3 className="font-semibold text-gray-900 text-sm truncate">{p.nombre}</h3>
          <p className="text-xs text-gray-400 truncate">{p.empresa} · {p.provincia}</p>
        </div>
        <label className="ml-2 cursor-pointer mt-0.5">
          <input type="checkbox" checked={on}
            onChange={e => onToggle(e.target.checked)}
            className="w-4 h-4" style={{ accentColor: color }} />
        </label>
      </div>
      <div className="mb-3">
        <div className="flex justify-between text-xs mb-4">
          <span className="text-gray-500">Inicio construcción</span>
          <span className="text-gray-600">prod. {prodInicio} · cierre {finProyecto}</span>
        </div>
        <YearSlider value={año} onChange={onAño} disabled={!on} color={color} />
      </div>
      <div className="grid grid-cols-3 gap-1.5 text-center">
        {[
          { l: 'Inversión',                       v: `$${(+p.inversion_mmusd).toLocaleString()}M` },
          { l: p.unidad_produccion || 'prod/año', v: (+p.produccion_fisica_anual).toLocaleString() },
          { l: 'Vida útil',                       v: `${ep.vU || '—'} a.` },
        ].map(({ l, v }) => (
          <div key={l} className="bg-gray-50 rounded-lg p-1.5">
            <div className="text-xs text-gray-400 leading-tight">{l}</div>
            <div className="font-semibold text-xs text-gray-800 mt-0.5">{v}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── TAB GANTT ─────────────────────────────────────────

function TabGantt({ proyectos, paramsMap, flujos, añosInicio, setAñosInicio, defaultAños, enabled, totals, horizon }) {
  const activos = proyectos.filter(p => enabled[p.nombre] !== false)
  const años = []
  for (let y = H_MIN; y <= horizon; y++) años.push(y)

  const matrix = activos.map(p => {
    const pm = paramsMap[p.grupo]
    const ep = pm ? getEffectiveParams(p, pm) : {}
    const añoI = añosInicio[p.nombre] ?? pN(p.anio_inicio_default)
    return {
      p,
      fases: años.map(y => getProjectFaseByYear(p, ep, flujos, añoI, y))
    }
  })

  const totMap = {}
  totals.forEach(t => { totMap[t.año] = t })

  return (
    <div className="space-y-4">
      {/* Panel de simulación */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
          <span className="text-sm font-semibold text-gray-800">Panel de simulación</span>
          <span className="text-xs text-gray-400 hidden sm:inline">mové los sliders para desplazar cada proyecto</span>
        </div>
        {activos.map((p, i) => {
          const pm = paramsMap[p.grupo]
          const ep = pm ? getEffectiveParams(p, pm) : {}
          const año = añosInicio[p.nombre] ?? pN(p.anio_inicio_default)
          const defAño = defaultAños[p.nombre] ?? año
          const prod = año + (ep.dC || 0)
          const fin  = prod + (ep.dR || 0) + (ep.vU || 0) + (ep.dCi || 0)
          const color = GC[p.grupo] || GC.otros
          const changed = año !== defAño
          return (
            <div key={p.nombre}
              className={`flex items-center gap-4 px-4 py-3 ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50/60'} border-b border-gray-100 last:border-0`}>
              {/* Nombre — ancho fijo igual al de la columna del Gantt */}
              <div className="flex items-center gap-2 min-w-36 w-36 flex-shrink-0">
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
                <span className={`text-xs font-medium truncate ${changed ? 'text-amber-600' : 'text-gray-800'}`}>
                  {p.nombre}
                </span>
              </div>
              {/* Slider — ocupa todo el espacio restante */}
              <div className="flex-1 min-w-0">
                <YearSlider value={año}
                  onChange={v => setAñosInicio(prev => ({ ...prev, [p.nombre]: v }))}
                  disabled={false} color={color} />
              </div>
              {/* Info derecha */}
              <div className="flex-shrink-0 text-right w-40 hidden sm:block">
                <div className="text-xs font-semibold" style={{ color }}>
                  {changed && <span className="text-amber-500 mr-1">({defAño}→)</span>}
                  {año}
                </div>
                <div className="text-xs text-gray-400">prod. {prod} · cierre {fin}</div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Gantt */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="flex items-center gap-4 px-4 py-3 border-b border-gray-100 flex-wrap">
          {Object.entries(FASE_LABEL).map(([k, v]) => (
            <span key={k} className="flex items-center gap-1.5 text-xs text-gray-600">
              <span className="w-3 h-3 rounded-sm inline-block" style={{ background: FASE_COLOR[k] }} />
              {v}
            </span>
          ))}
          <span className="flex items-center gap-1.5 text-xs text-gray-400 ml-auto">
            <span className="inline-block w-0.5 h-4 bg-red-500" />
            Hoy ({TODAY})
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="text-xs border-collapse w-full">
            <thead>
              <tr className="bg-gray-50">
                <th className="text-left px-3 py-2 font-medium text-gray-600 border-r border-gray-200 sticky left-0 bg-gray-50 z-10 min-w-36">
                  Proyecto
                </th>
                {años.map(y => (
                  <th key={y}
                    className={`py-2 font-medium text-center border-r border-gray-100 text-xs
                      ${y === TODAY ? 'bg-red-50 text-red-600' : 'text-gray-400'}`}
                    style={{ minWidth: 28 }}>
                    {y}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.map(({ p, fases }, i) => (
                <tr key={p.nombre} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}>
                  <td className="px-3 py-1.5 border-r border-gray-200 sticky left-0 z-10 font-medium text-gray-800"
                    style={{ background: i % 2 === 0 ? 'white' : '#fafafa' }}>
                    <div className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ background: GC[p.grupo] || GC.otros }} />
                      <span className="truncate max-w-32">{p.nombre}</span>
                    </div>
                  </td>
                  {fases.map((fase, j) => {
                    const y = años[j]
                    return (
                      <td key={y}
                        className={`border-r border-gray-100 ${y === TODAY ? 'border-l-2 border-l-red-400' : ''}`}
                        style={{ background: fase ? FASE_COLOR[fase] : 'transparent', opacity: fase ? 0.85 : 1 }}
                        title={fase ? `${p.nombre} — ${FASE_LABEL[fase]} ${y}` : ''}>
                        &nbsp;
                      </td>
                    )
                  })}
                </tr>
              ))}
              <tr><td colSpan={años.length + 1} className="h-px bg-gray-300" /></tr>
              {[
                { label: 'Inversión $M/año',   bg: 'bg-blue-50',   tc: 'text-blue-700',   fn: t => t.inv > 0 ? Math.round(t.inv/1e6) : '' },
                { label: 'Empleo total',        bg: 'bg-green-50',  tc: 'text-green-700',  fn: t => t.empTot > 0 ? fmtK(t.empTot) : '' },
                { label: 'Valor prod. $M/año',  bg: 'bg-amber-50',  tc: 'text-amber-700',  fn: t => t.valor > 0 ? Math.round(t.valor/1e6) : '' },
                { label: 'Ins. nacionales $M',  bg: 'bg-purple-50', tc: 'text-purple-700', fn: t => t.insNac > 0 ? Math.round(t.insNac/1e6) : '' },
              ].map(({ label, bg, tc, fn }) => (
                <tr key={label} className={`${bg} font-medium`}>
                  <td className={`px-3 py-1.5 border-r border-gray-200 sticky left-0 z-10 ${bg} ${tc}`}>{label}</td>
                  {años.map(y => {
                    const t = totMap[y]
                    return (
                      <td key={y} className={`text-center py-1.5 border-r border-gray-100 ${tc}
                        ${y === TODAY ? 'border-l-2 border-l-red-400' : ''}`}>
                        {t ? fn(t) : ''}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ── TAB DASHBOARD ─────────────────────────────────────

function TabDashboard({ kpis, chartData, chartsRef }) {
  const { sumInv, peak, peakVal, sumInsNac } = kpis
  const empty = !chartData.length
  const refLine = (
    <ReferenceLine x={TODAY_FRAC} stroke="#dc2626" strokeWidth={1.5} strokeDasharray="4 3"
      label={{ value: TODAY_LABEL, position: 'insideTopRight', fill: '#dc2626', fontSize: 10 }} />
  )
  const refArea = <ReferenceArea x1={H_MIN} x2={TODAY_FRAC} fill="#94a3b8" fillOpacity={0.1} />
  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <KpiCard title="Inversión en construcción total" value={fmt$(sumInv)} sub="acumulado en el horizonte" accent="#0284c7" />
        <KpiCard title="Pico de empleo (directo + indirecto)" value={peak ? fmtK(peak.empTot) : '—'} sub={peak ? `en ${peak.año}` : ''} accent="#059669" />
        <KpiCard title="Valor de producción pico anual" value={fmt$(peakVal)} sub="todos los grupos" accent="#d97706" />
        <KpiCard title="Insumos nacionales acumulados" value={fmt$(sumInsNac)} sub="demanda local estimada" accent="#7c3aed" />
      </div>
      {empty ? (
        <div className="text-center py-16 text-gray-400 text-sm">Activá al menos un proyecto para ver el dashboard.</div>
      ) : (
        <>
          <div className="flex items-center gap-4 text-xs text-gray-400 mb-5 bg-white rounded-xl border border-gray-200 px-4 py-2.5 flex-wrap">
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-5 h-3 rounded-sm bg-slate-400 opacity-40" />En curso / pasado
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-5 border-t-2 border-dashed border-red-500" />{TODAY_LABEL} — hoy
            </span>
            <span className="text-gray-300 hidden sm:inline">|</span>
            <span className="hidden sm:inline">Todo lo que está a la derecha de la línea roja son proyecciones, no datos confirmados.</span>
          </div>
          <div ref={chartsRef} className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <ChartCard title="Inversión en construcción (USD M/año)" sub="por grupo mineral">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                <XAxis dataKey="año" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip formatter={v => [`$${v.toLocaleString()}M`]} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {refArea}{refLine}
                <Bar dataKey="cobre_inv" name="Cobre"      stackId="a" fill={GC.cobre} />
                <Bar dataKey="litio_inv"  name="Litio"     stackId="a" fill={GC.litio} />
                <Bar dataKey="oro_inv"    name="Oro/Plata" stackId="a" fill={GC.oro_plata} />
                <Bar dataKey="otros_inv"  name="Otros"     stackId="a" fill={GC.otros} />
              </BarChart>
            </ChartCard>
            <ChartCard title="Empleo total estimado" sub="construcción + operación (directo e indirecto)">
              <AreaChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                <XAxis dataKey="año" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={fmtK} />
                <Tooltip formatter={v => [fmtK(v), '']} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {refArea}{refLine}
                <Area type="monotone" dataKey="empC" name="Construcción" stackId="a" fill="#93c5fd" stroke="#3b82f6" fillOpacity={0.8} />
                <Area type="monotone" dataKey="empO" name="Operación"    stackId="a" fill="#6ee7b7" stroke="#10b981" fillOpacity={0.8} />
              </AreaChart>
            </ChartCard>
            <ChartCard title="Valor de producción (USD M/año)" sub="por grupo mineral">
              <AreaChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                <XAxis dataKey="año" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip formatter={v => [`$${v.toLocaleString()}M`]} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {refArea}{refLine}
                {GRUPOS.map(g => (
                  <Area key={g} type="monotone" dataKey={`${g === 'oro_plata' ? 'oro' : g}_val`}
                    name={GL[g]} stackId="a" fill={GC[g]} stroke={GC[g]} fillOpacity={0.65} />
                ))}
              </AreaChart>
            </ChartCard>
            <ChartCard title="Insumos: nacionales vs importados (USD M/año)" sub="estimado por fase">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                <XAxis dataKey="año" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip formatter={v => [`$${v.toLocaleString()}M`]} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {refArea}{refLine}
                <Bar dataKey="insNac" name="Nacionales" fill="#4ade80" />
                <Bar dataKey="insImp" name="Importados"  fill="#f87171" />
              </BarChart>
            </ChartCard>
          </div>
        </>
      )}
    </div>
  )
}

// ── TAB METODOLOGÍA ───────────────────────────────────

function TabMetodologia() {
  return (
    <div className="max-w-2xl">
      <div className="bg-white rounded-xl border border-gray-200 p-6 text-sm text-gray-700 leading-relaxed space-y-4">
        <h2 className="text-base font-semibold text-gray-900">Modelo de impacto económico</h2>
        <p>Cada proyecto atraviesa cuatro fases: <strong>construcción</strong> (curva S), <strong>ramp-up</strong>, <strong>operación</strong> y <strong>cierre</strong>. Los parámetros se leen desde la sheet. La pestaña <em>FLUJOS_PROYECTO</em> usa <strong>año_calendario</strong> para reflejar datos reales históricos y proyectados con máxima flexibilidad — incluyendo proyectos con historia compleja (cierres, reactivaciones, fases múltiples).</p>
        <p>El slider de año de inicio es para simulación temporal sin modificar la sheet. Si un proyecto se retrasa, se mueve el slider o se actualiza la sheet. La línea roja en los gráficos marca el mes y año actual.</p>
        <div className="bg-gray-50 rounded-lg p-4 font-mono text-xs text-gray-600 space-y-1">
          <div>valor_año = producción × precio_referencia[mineral][año]</div>
          <div>empleo_total = empleo_directo × (1 + multiplicador_indirecto)</div>
          <div>insumos_nac = valor_año × pct_insumos_op × pct_nacional</div>
        </div>
        <div>
          <div className="text-xs font-medium text-gray-600 mb-2">Estados del proyecto:</div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(ESTADO_COLOR).map(([est, col]) => (
              <span key={est} className="text-xs text-white px-2 py-0.5 rounded-full"
                style={{ background: col }}>{est}</span>
            ))}
          </div>
        </div>
        <p className="text-xs text-gray-400">Para agregar un proyecto: nueva fila en <em>PROYECTOS</em>. Para agregar un grupo mineral: nueva fila en <em>PARAMETROS_GRUPO</em> y curvas en <em>CURVAS_PERFIL</em>. Para cargar datos reales o proyecciones específicas: fila en <em>FLUJOS_PROYECTO</em> con año_calendario.</p>
      </div>
    </div>
  )
}
