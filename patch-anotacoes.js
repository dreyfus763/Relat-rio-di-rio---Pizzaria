/* PATCH ANOTAÇÕES PERMANENTES — versão 2
   Fica em arquivo separado (patch-anotacoes.js), carregado pelo pizzaria.html. */
(function(){
'use strict';

// ---------- configuração ----------
const DV_PATH='pizzaria_devias';      // lista única e permanente
const LOG_PATH='pizzaria_log';        // aba de Registros (só acrescenta)
const DV_CACHE='piz_dv_cache', LOG_CACHE='piz_log_cache', OUTBOX='piz_dv_outbox', MIG_FLAG='piz_dv_migrado', CORTE='piz_dv_corte';
const DIAS_MIGRAR=0;                  // só traz as anotações de HOJE do formato antigo (1ª vez)
const DIAS_PENDENTE=7;                // pendente com mais de 7 dias sai da aba Pendentes (fica só nos registros)

let itens={}, logs={};
let regTab='log', origemReg='home';
let negadoEm=0;                       // última vez que o Firebase recusou uma gravação

// ---------- utilidades ----------
const $=id=>document.getElementById(id);
const pad=n=>String(n).padStart(2,'0');
const hoje=()=>todayStr();
const agora=()=>Date.now();
function lerJSON(k,def){try{const v=JSON.parse(localStorage.getItem(k));return v==null?def:v;}catch(e){return def;}}
function gravarJSON(k,v){try{localStorage.setItem(k,JSON.stringify(v));}catch(e){}}
function salvarLocal(){gravarJSON(DV_CACHE,itens);gravarJSON(LOG_CACHE,logs);}
function novoId(p){return p+Date.now().toString(36)+Math.random().toString(36).slice(2,6);}
function fmtHora(ts){const d=new Date(ts);return pad(d.getDate())+'/'+pad(d.getMonth()+1)+' '+pad(d.getHours())+':'+pad(d.getMinutes());}
function primeiraLinha(s){return String(s||'').split('\n')[0];}
function diaMenos(n,base){const [y,m,d]=(base||hoje()).split('-').map(Number);const dt=new Date(y,m-1,d-n);return dt.getFullYear()+'-'+pad(dt.getMonth()+1)+'-'+pad(dt.getDate());}
function modalAberto(){return !!document.querySelector('.modal-bg[style*="flex"]');}
function versao(it){return (it&&(it.atualizadoEm||it.criadoEm))||0;}
function corte(){let c=lerJSON(CORTE,'');if(!c){c=hoje();gravarJSON(CORTE,c);}return c;}
// Só valem anotações de hoje em diante (a partir do dia em que o patch começou a rodar)
function valido(i){return !!i&&i.criadoDia>=corte();}
// Pendente com mais de 7 dias sai da aba Pendentes
function expirado(i,ref){return i.criadoDia<diaMenos(DIAS_PENDENTE,ref||hoje());}
function soHora(ts){const d=new Date(ts);return pad(d.getHours())+':'+pad(d.getMinutes());}

// ---------- envio ao Firebase com fila (funciona offline) ----------
let enviando=false;
async function fluxo(){
  if(enviando) return; enviando=true;
  try{
    let fila=lerJSON(OUTBOX,[]);
    while(fila.length){
      const op=fila[0]; let ok=true;
      try{
        const res=await fetch(firebaseUrl(op.p),{method:op.m,headers:{'Content-Type':'application/json'},body:JSON.stringify(op.b)});
        if(res.status>=500) ok=false;
        else if(res.status===401||res.status===403){
          negadoEm=agora();
          if(!op.q) setStatusSafe('⚠️ O Firebase recusou uma gravação (confira as regras)','#f59e0b');
        } else if(res.ok&&negadoEm){
          negadoEm=0; setStatusSafe('☁️ Sincronizado','#1D9E75');
        }
      }catch(e){ok=false;}
      if(!ok) break;
      fila=lerJSON(OUTBOX,[]); fila.shift(); gravarJSON(OUTBOX,fila);
    }
  } finally {enviando=false;}
}
function remoto(m,p,b,quieto){
  const f=lerJSON(OUTBOX,[]); f.push({m,p,b,q:quieto?1:0}); gravarJSON(OUTBOX,f);
  return fluxo();
}

// Junta o que está neste aparelho com o que está no Firebase, SEM apagar nada local.
// Itens que só existem aqui (ex.: gravação recusada antes) são reenviados.
function escolher(a,b){
  if(!a) return b; if(!b) return a;
  if(b.travado&&!a.travado) return b;
  if(a.travado&&!b.travado) return a;
  return versao(a)>=versao(b)?a:b;
}
async function sincronizar(){
  try{
    await fluxo();
    const [r,l]=await Promise.all([firebaseGet(DV_PATH),firebaseGet(LOG_PATH)]);
    const R=r||{}, L=l||{};
    const nI={}, nL={...L};
    new Set([...Object.keys(itens),...Object.keys(R)]).forEach(id=>{const x=escolher(itens[id],R[id]);if(valido(x))nI[id]=x;});
    Object.keys(logs).forEach(id=>{if(!nL[id])nL[id]=logs[id];});
    Object.keys(nL).forEach(id=>{if(!(nL[id]&&nL[id].dia>=corte()))delete nL[id];});
    // reenvio do que o Firebase não tem (ou tem mais velho)
    if(agora()-negadoEm>5*60e3){
      Object.keys(nI).forEach(id=>{
        const it=nI[id], rm=R[id];
        if(!rm) remoto('PUT',DV_PATH+'/'+id,it,true);
        else if(!rm.travado&&versao(it)>versao(rm)) remoto('PUT',DV_PATH+'/'+id,it,true);
      });
      Object.keys(nL).forEach(id=>{if(!L[id]) remoto('PUT',LOG_PATH+'/'+id,nL[id],true);});
    }
    const mudou=JSON.stringify(nI)!==JSON.stringify(itens)||JSON.stringify(nL)!==JSON.stringify(logs);
    itens=nI; logs=nL; salvarLocal();
    return mudou;
  }catch(e){return false;}
}

// ---------- registro de alterações (aba Registros) ----------
// Sem nome de funcionário: só horário, o que foi feito e valores antes/depois.
function registrar(acao,it,antes,depois,motivo){
  const e={id:novoId('l'),ts:agora(),dia:hoje(),acao};
  if(it){e.itemId=it.id;e.nome=it.nome||'';e.tipo=it.tipo||'';e.val=Number(it.val)||0;}
  if(antes)e.antes=antes; if(depois)e.depois=depois; if(motivo)e.motivo=motivo;
  logs[e.id]=e; salvarLocal();
  remoto('PUT',LOG_PATH+'/'+e.id,e);
}
function resumo(it){return primeiraLinha(it.nome)+' | R$ '+fmt(it.val)+' | '+(it.tipo==='devem'?'Devem':'Devemos');}

// ---------- operações nas anotações ----------
function dvCriar(tipo,nome,val,det){
  const t=agora();
  const it={id:novoId('d'),tipo:tipo==='devem'?'devem':'devemos',nome:nome,val:Number(val)||0,det:det||'',criadoEm:t,atualizadoEm:t,criadoDia:hoje(),pago:false};
  itens[it.id]=it; salvarLocal();
  remoto('PUT',DV_PATH+'/'+it.id,it);
  registrar('criado',it,'',resumo(it));
  return it;
}
window.dvMarcar=function(id,pago){
  const it=itens[id];
  if(!it||it.travado||it.cancelado){window.renderDevia();return;}
  const t=agora();
  if(pago){
    it.pago=true;it.pagoEm=t;it.pagoDia=hoje();it.atualizadoEm=t;
    remoto('PATCH',DV_PATH+'/'+id,{pago:true,pagoEm:t,pagoDia:it.pagoDia,atualizadoEm:t});
    registrar('pago',it,'pendente','pago');
  } else {
    if(it.pagoDia!==hoje()){alert('Essa anotação foi paga em outro dia e não pode mais ser desmarcada.');window.renderDevia();return;}
    if(!confirm('Desmarcar como pago? Isso fica registrado.')){window.renderDevia();dvRenderRegistros();return;}
    it.pago=false;delete it.pagoEm;delete it.pagoDia;it.atualizadoEm=t;
    remoto('PATCH',DV_PATH+'/'+id,{pago:false,pagoEm:null,pagoDia:null,atualizadoEm:t});
    registrar('desmarcado',it,'pago','pendente');
  }
  salvarLocal(); window.renderDevia(); dvRenderRegistros();
};
function dvEditar(id,campos){
  const it=itens[id]; if(!it||it.travado||it.cancelado) return;
  const antes=resumo(it);
  const novo={nome:campos.nome,val:Number(campos.val)||0,tipo:campos.tipo==='devem'?'devem':'devemos'};
  if(novo.nome===it.nome&&novo.val===it.val&&novo.tipo===it.tipo) return;
  novo.atualizadoEm=agora();
  Object.assign(it,novo); salvarLocal();
  remoto('PATCH',DV_PATH+'/'+id,novo);
  registrar('editado',it,antes,resumo(it));
}
window.dvCancelar=function(id){
  const it=itens[id]; if(!it||it.travado||it.cancelado) return;
  const motivo=(prompt('Por que cancelar "'+primeiraLinha(it.nome)+'"? (obrigatório)')||'').trim();
  if(!motivo){alert('Cancelamento exige um motivo.');return;}
  const t=agora();
  it.cancelado=true;it.cancelEm=t;it.cancelMotivo=motivo;it.travado=true;it.atualizadoEm=t;
  salvarLocal();
  remoto('PATCH',DV_PATH+'/'+id,{cancelado:true,cancelEm:t,cancelMotivo:motivo,travado:true,atualizadoEm:t});
  registrar('cancelado',it,resumo(it),'',motivo);
  window.renderDevia(); dvRenderRegistros();
};
window.dvAbrirEdicao=function(id){const it=itens[id];if(!it||it.travado)return;window._openModalDevia(id,'main',it);};

// Pago em dia anterior => trava de vez (histórico inalterável)
function travarAntigos(){
  const h=hoje();
  Object.values(itens).forEach(it=>{
    if(!it.travado&&it.pago&&it.pagoDia&&it.pagoDia<h){
      const t=agora(); it.travado=true; it.atualizadoEm=t;
      remoto('PATCH',DV_PATH+'/'+it.id,{travado:true,atualizadoEm:t},true);
    }
  });
  salvarLocal();
}

// ---------- listas ----------
// Lista principal = só o que foi anotado HOJE.
// Anotações de outros dias ficam na aba "Pendentes" (dentro de Registros).
function doDia(tipo){return Object.values(itens).filter(i=>valido(i)&&i.tipo===tipo&&!i.cancelado&&i.criadoDia===hoje());}
function outrosDias(tipo){return Object.values(itens).filter(i=>valido(i)&&i.tipo===tipo&&!i.cancelado&&i.criadoDia!==hoje()&&!expirado(i)&&(!i.pago||i.pagoDia===hoje()));}
function ordemLista(a,b){
  if(!!a.pago!==!!b.pago) return a.pago?1:-1;
  return a.criadoEm-b.criadoEm;
}
function soma(l){return l.reduce((s,i)=>s+(Number(i.val)||0),0);}
function agrupar(lista){
  const m=new Map();
  lista.forEach(i=>{const k=normalizaNome(primeiraLinha(i.nome))||i.id;if(!m.has(k))m.set(k,[]);m.get(k).push(i);});
  return [...m.values()];
}
function casa(i,termo){return !termo||(i.nome||'').toLowerCase().includes(termo)||(i.det||'').toLowerCase().includes(termo);}

function cartao(it){
  const devem=it.tipo==='devem', bloq=!!it.travado;
  const corVal=devem?'var(--red)':'var(--green)';
  const info=(devem?'Devem · ':'Devemos · ')+'lançado '+fmtHora(it.criadoEm)+(it.pago&&it.pagoEm?' · pago '+fmtHora(it.pagoEm):'');
  return '<div class="devia-card '+(devem?'devem':'')+'" style="'+(it.pago?'opacity:.8;':'')+'">'+
    '<div style="display:flex;gap:8px;align-items:flex-start;min-width:0;">'+
      '<input type="checkbox" '+(it.pago?'checked ':'')+(bloq?'disabled ':'')+'onchange="dvMarcar(\''+it.id+'\',this.checked)" style="margin-top:2px;width:16px;height:16px;flex-shrink:0;"/>'+
      '<div style="min-width:0;">'+
        '<div style="font-weight:700;font-size:12px;line-height:1.4;white-space:pre-line;'+(it.pago?'text-decoration:line-through;':'')+'">'+escapeHTML(it.nome)+'</div>'+
        (it.val?'<div style="color:'+corVal+';font-size:12px;font-weight:600;margin-top:1px;">R$ '+fmt(it.val)+'</div>':'')+
        (it.det?'<div style="font-size:11px;color:var(--muted);margin-top:1px;">'+escapeHTML(it.det)+'</div>':'')+
        '<div style="font-size:9px;color:var(--muted);margin-top:2px;">'+info+(bloq?' · 🔒':'')+'</div>'+
      '</div>'+
    '</div>'+
    (bloq?'':'<div style="display:flex;gap:4px;flex-shrink:0;">'+
      '<button onclick="dvAbrirEdicao(\''+it.id+'\')" class="btn btn-gray" style="padding:2px 6px;font-size:10px;">✏️</button>'+
      '<button onclick="dvCancelar(\''+it.id+'\')" class="btn btn-red" style="padding:2px 6px;font-size:10px;" title="Cancelar (pede motivo)">✕</button>'+
    '</div>')+
  '</div>';
}

function montarLista(tipo){
  const termo=termoBuscaGlobal();
  const hojeL=doDia(tipo).filter(i=>casa(i,termo)).sort(ordemLista);
  const outros=outrosDias(tipo).filter(i=>casa(i,termo));
  const pend=outros.filter(i=>!i.pago);
  let html=hojeL.map(cartao).join('');
  if(outros.length){
    html+='<div onclick="dvAbrirPendentes()" style="cursor:pointer;font-size:12px;font-weight:700;color:var(--orange);padding:8px 10px;margin:6px 0;border:1px dashed var(--orange);border-radius:7px;display:flex;justify-content:space-between;gap:8px;">'+
      '<span>▸ Pendentes de outros dias ('+pend.length+')</span></div>';
  }
  if(!html) return termo?'<div class="empty">Nenhum resultado para "'+escapeHTML(termo)+'".</div>':'<div class="empty">Nada aqui ainda.</div>';
  return html;
}
window.renderDevia=function(){
  const a=$('devia-list'), b=$('devem-list');
  if(a)a.innerHTML=montarLista('devemos');
  if(b)b.innerHTML=montarLista('devem');
};
window.eRenderDevia=function(){window.renderDevia();};

// ---------- modal Anotar (criar/editar) ----------
window._openModalDevia=function(id,ctx,d,tipoInicial){
  $('md-idx').value=id||''; $('md-ctx').value=ctx||'main';
  $('md-nome').value=d?d.nome||'':''; setMoneyField('md-val',d?d.val:'');
  selecionarTipoDevia(d?(d.tipo||'devemos'):(tipoInicial||'devemos'));
  abrirModal('modal-devia');
};
window.abrirModalDevia=function(t){window._openModalDevia('','main',null,t);};
window.eAbrirModalDevia=window.abrirModalDevia;
window.salvarDevia=function(){
  const nome=$('md-nome').value.trim(); if(!nome){alert('Digite o nome.');return;}
  const val=parseMoney($('md-val').value)||0;
  const tipo=$('md-tipo').value||'devemos';
  const id=$('md-idx').value;
  if(id) dvEditar(id,{nome,val,tipo}); else dvCriar(tipo,nome,val,'');
  fecharModal('modal-devia'); window.renderDevia(); dvRenderRegistros();
};

// ---------- texto do relatório ----------
const gerarTextoBase=gerarTexto;
function textoAnotacoes(dk){
  const arr=Object.values(itens).filter(i=>valido(i)&&!expirado(i,dk)&&!i.cancelado&&i.criadoDia<=dk&&(!i.pago||i.pagoDia>=dk)).sort((a,b)=>a.criadoEm-b.criadoEm);
  const linha=i=>i.nome+(i.val?' - R$ '+fmt(i.val):'')+(i.det?' - '+i.det:'')+
    (i.criadoDia<dk?' (anotado '+fmtHora(i.criadoEm)+')':'')+(i.pago&&i.pagoDia===dk?' ✔ PAGO':'');
  let t='';
  const dv=arr.filter(i=>i.tipo==='devemos'), de=arr.filter(i=>i.tipo==='devem');
  if(dv.length) t+='DEVEMOS:\n'+dv.map(linha).join('\n')+'\n\n';
  if(de.length) t+='DEVEM:\n'+de.map(linha).join('\n')+'\n';
  return t.trim();
}
window.gerarTexto=function(st,dk){
  if(dk<corte()) return gerarTextoBase(st,dk);                 // dias antes do patch: como eram
  const base=gerarTextoBase({...st,devias:[]},dk);             // dias novos: lista permanente
  const extra=textoAnotacoes(dk);
  return extra?(base+'\n\n'+extra).trim():base;
};

// ---------- trazer anotações dos relatórios antigos ----------
async function migrar(dias){
  const keys=await window._loadAllKeys();
  const limite=diaMenos(dias);
  let novos=0;
  for(const k of keys){
    if(k<limite) continue;
    const st=(currentDate===k&&state)?state:window._getCached(k);
    if(!st||!st.devias||!st.devias.length) continue;
    const [y,m,dd]=k.split('-').map(Number);
    st.devias.forEach((d,idx)=>{
      const id='m_'+k+'_'+idx;
      if(itens[id]) return;
      const t=new Date(y,m-1,dd,12,0).getTime();
      const it={id,tipo:d.tipo==='devem'?'devem':'devemos',nome:d.nome||'',val:Number(d.val)||0,det:d.det||'',
        criadoEm:t,atualizadoEm:t,criadoDia:k,pago:false,migrado:true};
      itens[id]=it; remoto('PUT',DV_PATH+'/'+id,it); novos++;
    });
  }
  corte();
  salvarLocal();
  if(novos) registrar('migracao',null,'',novos+' anotação(ões) de hoje trazida(s) do formato antigo');
  return novos;
}

// ---------- aba Registros (Alterações | Pendentes | Pagos) ----------
const ABAS=['log','pend','pagos'];
function montarPaginaRegistros(){
  const p=document.createElement('div'); p.className='page'; p.id='page-reg';
  p.innerHTML=
   '<div class="ctr" style="padding-top:16px;">'+
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">'+
      '<button class="btn btn-gray" onclick="dvVoltarRegistros()">←</button>'+
      '<div style="font-size:16px;font-weight:700;">📜 Registros</div></div>'+
    '<div style="display:flex;gap:4px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:3px;margin-bottom:12px;">'+
      '<button id="reg-tab-log" class="btn btn-green" onclick="dvRegTab(\'log\')" style="flex:1;border-radius:7px;">Alterações</button>'+
      '<button id="reg-tab-pend" class="btn btn-gray" onclick="dvRegTab(\'pend\')" style="flex:1;border-radius:7px;">Pendentes</button>'+
      '<button id="reg-tab-pagos" class="btn btn-gray" onclick="dvRegTab(\'pagos\')" style="flex:1;border-radius:7px;">Pagos</button></div>'+
    '<input type="text" id="reg-busca" class="func-search" placeholder="🔍 Buscar por nome..." oninput="dvRenderRegistros()"/>'+
    '<div id="reg-conteudo"></div>'+
    '<div style="font-size:11px;color:var(--muted);margin-top:10px;line-height:1.5;">Os registros só acumulam: nada aqui pode ser editado ou apagado pelo app.</div>'+
   '</div>';
  document.body.appendChild(p);
}
function mostrarRegistros(tab){
  origemReg=($('page-rel')&&$('page-rel').classList.contains('active'))?'rel':(origemReg==='rel'&&$('page-reg').classList.contains('active')?'rel':'home');
  showPage('page-reg'); dvRegTab(tab||regTab); window.scrollTo(0,0);
}
window.dvAbrirRegistros=function(){mostrarRegistros(regTab);};
window.dvAbrirPendentes=function(){mostrarRegistros('pend');};
window.dvVoltarRegistros=function(){ if(origemReg==='rel'){showPage('page-rel');window.renderDevia();} else irHome(); };
window.dvRegTab=function(t){
  regTab=t;
  ABAS.forEach(a=>{const b=$('reg-tab-'+a); if(b){b.className='btn '+(a===t?'btn-green':'btn-gray');b.style.flex='1';b.style.borderRadius='7px';}});
  dvRenderRegistros();
};
function descLog(e){
  const v=e.val?' · R$ '+fmt(e.val):'';
  const nome='<b>'+escapeHTML(primeiraLinha(e.nome||''))+'</b>';
  const t=e.tipo==='devem'?'Devem':'Devemos';
  switch(e.acao){
    case 'criado':     return {txt:'Anotado em '+t+': '+nome+v,cor:'var(--text)'};
    case 'pago':       return {txt:'Marcado como pago: '+nome+v,cor:'var(--green)'};
    case 'desmarcado': return {txt:'Desmarcado (voltou a pendente): '+nome+v,cor:'var(--orange)'};
    case 'editado':    return {txt:'Editado: antes ['+escapeHTML(e.antes||'')+'] → depois ['+escapeHTML(e.depois||'')+']',cor:'var(--orange)'};
    case 'cancelado':  return {txt:'Cancelado: '+nome+v+' — motivo: '+escapeHTML(e.motivo||''),cor:'var(--red)'};
    case 'migracao':   return {txt:escapeHTML(e.depois||'Anotações trazidas'),cor:'var(--muted)'};
    default:           return {txt:escapeHTML(e.acao||''),cor:'var(--text)'};
  }
}
window.dvRenderRegistros=function(){
  const el=$('reg-conteudo'); if(!el) return;
  const termo=(($('reg-busca')||{}).value||'').trim().toLowerCase();
  if(regTab==='log'){
    let l=Object.values(logs).filter(e=>e.dia>=corte()).sort((a,b)=>b.ts-a.ts)
      .filter(e=>!termo||(e.nome||'').toLowerCase().includes(termo)||(e.motivo||'').toLowerCase().includes(termo));
    const total=l.length; l=l.slice(0,200);
    let html='', ultimo='';
    l.forEach(e=>{
      if(e.dia!==ultimo){ultimo=e.dia;html+='<div class="func-group-label">'+fmtDate(e.dia)+'</div>';}
      const d=descLog(e);
      html+='<div class="item-card"><div class="item-left"><div style="font-size:10px;color:var(--muted);">'+soHora(e.ts)+'</div>'+
            '<div style="font-size:12px;color:'+d.cor+';">'+d.txt+'</div></div></div>';
    });
    if(total>200) html+='<div class="empty">Mostrando os 200 mais recentes de '+total+'. Use a busca para achar outros.</div>';
    el.innerHTML=html||'<div class="empty">Nenhum registro ainda.</div>';
  } else if(regTab==='pend'){
    const l=[...outrosDias('devemos'),...outrosDias('devem')].filter(i=>casa(i,termo));
    const nota='<div style="font-size:11px;color:var(--muted);margin-bottom:8px;line-height:1.5;">Pendentes com mais de '+DIAS_PENDENTE+' dias saem desta aba e ficam só em "Alterações".</div>';
    if(!l.length){el.innerHTML=nota+'<div class="empty">Nenhuma pendência de outros dias.</div>';return;}
    const dias=[...new Set(l.map(i=>i.criadoDia))].sort().reverse();
    el.innerHTML=nota+dias.map(d=>{
      const g=l.filter(i=>i.criadoDia===d).sort(ordemLista);
      const ab=g.filter(i=>!i.pago).length;
      return '<div class="func-group-label">'+fmtDate(d)+' ('+ab+' pendente'+(ab===1?'':'s')+')</div>'+g.map(cartao).join('');
    }).join('');
  } else {
    const pagos=Object.values(itens).filter(i=>valido(i)&&i.pago&&!i.cancelado&&casa(i,termo));
    if(!pagos.length){el.innerHTML='<div class="empty">Nenhum pagamento registrado ainda.</div>';return;}
    const dias=[...new Set(pagos.map(i=>i.pagoDia||'sem data'))].sort().reverse();
    el.innerHTML=dias.map(d=>{
      const g=pagos.filter(i=>(i.pagoDia||'sem data')===d).sort((a,b)=>(b.pagoEm||0)-(a.pagoEm||0));
      return '<details class="item-card" style="display:block;">'+
        '<summary style="cursor:pointer;font-size:13px;font-weight:700;">'+(d==='sem data'?d:fmtDate(d))+
        ' <span style="color:var(--muted);font-weight:500;">— '+g.length+' pago(s) · R$ '+fmt(soma(g))+'</span></summary>'+
        g.map(i=>'<div style="font-size:12px;padding:5px 0;border-bottom:1px dashed var(--border);"><b>'+escapeHTML(primeiraLinha(i.nome))+'</b> · R$ '+fmt(i.val)+
          ' · '+(i.tipo==='devem'?'Devem':'Devemos')+' · lançado '+fmtHora(i.criadoEm)+' · <span style="color:var(--green);">pago '+(i.pagoEm?soHora(i.pagoEm):'?')+'</span>'+(i.travado?' 🔒':'')+'</div>').join('')+
      '</details>';
    }).join('');
  }
};

// ---------- botões novos na tela ----------
function injetarBotoes(){
  const cfg=[...document.querySelectorAll('#page-home button')].find(b=>(b.getAttribute('onclick')||'').indexOf('irConfig')>=0);
  if(cfg){
    const b=document.createElement('button');
    b.className='btn btn-gray'; b.style.cssText='margin-top:12px;padding:10px 24px;';
    b.textContent='📜 Registros'; b.onclick=function(){dvAbrirRegistros();};
    cfg.insertAdjacentElement('afterend',b);
  }
  const lista=$('devia-list'), sec=lista&&lista.closest('.sec'), tit=sec&&sec.querySelector('.sec-title');
  if(tit){
    const b=document.createElement('button');
    b.className='btn btn-gray'; b.style.cssText='padding:2px 7px;font-size:11px;';
    b.textContent='📜'; b.title='Registros, pendentes e pagos'; b.onclick=function(){dvAbrirRegistros();};
    tit.appendChild(b);
  }
}

// ---------- ajustes de tela ----------
function injetarCss(){
  const st=document.createElement('style'); st.id='dv-css';
  st.textContent=
   '#func-list .func-card{padding:5px 9px;margin-bottom:4px;}'+
   '#func-list .func-name{font-size:12px;}'+
   '#func-list .func-horario{font-size:11px;padding:1px 6px;}'+
   '#func-list .func-turno-row{gap:1px;}'+
   '#func-list .func-consumo,#func-list .func-obs{font-size:11px;margin-top:2px;}'+
   '#func-list .func-pag{font-size:12px;margin-top:2px;}'+
   '#func-list .func-card .btn{padding:2px 6px !important;font-size:10px !important;}'+
   '#func-list .func-group-label{margin:6px 0 3px;font-size:10px;}'+
   // demais cards: menores que antes, porém um pouco maiores que os de funcionários
   '.sec:not(.dv-func) > .sec-hdr{padding:8px 12px;}'+
   '.sec:not(.dv-func) > .sec-body{padding:9px 12px;}'+
   '.sec:not(.dv-func) .sec-title{font-size:12.5px;}'+
   '.sec:not(.dv-func) > .sec-hdr .btn{padding:5px 10px;font-size:12px;}'+
   '.item-card{padding:6px 9px;margin-bottom:5px;}'+
   '.item-card .item-val{font-size:13px;}'+
   '.item-card .item-desc{font-size:12px !important;}'+
   '.item-card .item-actions .btn{padding:2px 6px !important;font-size:10px !important;}'+
   '.dep-card{padding:6px 9px;margin-bottom:5px;font-size:13px;}'+
   '.dep-card .btn{padding:2px 6px !important;font-size:10px !important;}'+
   '.devia-card{padding:6px 9px;margin-bottom:4px;}'+
   '.total-box{padding:7px 10px;margin-top:6px;font-size:13px;}'+
   '#tab-anotar .fg input,#tab-anotar .fg select{padding:6px 9px;font-size:13px;}'+
   '#tab-anotar .empty{padding:10px;}'+
   // histórico: sem botão Editar
   '#hist-content button[onclick^="editarDia"]{display:none !important;}'+
   // raios do Fabinho
   '.dv-bolt{opacity:0;animation:dvBolt 2.8s linear infinite;animation-delay:var(--d,0s);filter:drop-shadow(0 0 1.5px #4fd8ff) drop-shadow(0 0 3px rgba(79,216,255,.6));}'+
   '.dv-flash{opacity:0;animation:dvFlash 2.8s linear infinite;animation-delay:var(--d,0s);}'+
   '@keyframes dvBolt{0%,100%{opacity:0}2%{opacity:1}3.5%{opacity:.2}5%{opacity:1}8%{opacity:0}48%{opacity:0}49.5%{opacity:.9}51%{opacity:.15}52.5%{opacity:1}56%{opacity:0}}'+
   '@keyframes dvFlash{0%,100%{opacity:0}2%{opacity:.09}3.5%{opacity:0}5%{opacity:.09}8%{opacity:0}48%{opacity:0}49.5%{opacity:.07}52.5%{opacity:.09}56%{opacity:0}}';
  document.head.appendChild(st);
}
// Importar texto não é mais necessário: some da tela
function removerImportar(){
  const b=document.querySelector('button[onclick="abrirModalImport()"]');
  if(b){const linha=b.closest('.btn-row'); (linha||b).remove();}
}
// Card de Funcionários: fechado por padrão; abre no clique ou quando a busca acha alguém
let funcManual=false, funcSuprimido=false, ultimoTermo='';
function funcAchou(termo){
  const lista=(state&&state.funcionarios)||[];
  return !!termo&&lista.some(f=>(f.nome||'').toLowerCase().includes(termo));
}
function prepararFuncCard(){
  const lista=$('func-list'); if(!lista) return;
  const corpo=lista.closest('.sec-body'), sec=lista.closest('.sec'), tit=sec&&sec.querySelector('.sec-title');
  if(!corpo||!tit) return;
  corpo.id='func-corpo'; tit.id='func-titulo'; sec.classList.add('dv-func');
  tit.style.cssText+='cursor:pointer;flex:1;user-select:none;';
  tit.onclick=function(){
    const termo=termoBuscaGlobal();
    const aberto=funcManual||(funcAchou(termo)&&!funcSuprimido);
    if(aberto){funcManual=false; if(funcAchou(termo)) funcSuprimido=true;}
    else{funcManual=true; funcSuprimido=false;}
    atualizarFuncCard();
  };
}
function atualizarFuncCard(){
  const corpo=$('func-corpo'), tit=$('func-titulo'); if(!corpo||!tit) return;
  const termo=termoBuscaGlobal();
  if(termo!==ultimoTermo){ultimoTermo=termo; funcSuprimido=false;}
  const aberto=funcManual||(funcAchou(termo)&&!funcSuprimido);
  corpo.style.display=aberto?'':'none';
  const n=((state&&state.funcionarios)||[]).length;
  tit.innerHTML=(aberto?'▾':'▸')+' 👥 Funcionários <span style="color:var(--muted);font-weight:500;">('+n+')</span>';
  if(aberto) ajustarRaios();
}
const renderFuncBase=renderFunc;
window.renderFunc=function(){renderFuncBase();atualizarFuncCard();};

// ---------- sem botão de enviar horários pra planilha ----------
function removerEnviarPlanilha(){
  const b=document.querySelector('button[onclick="abrirModalPlanilha()"]');
  if(b) b.remove();
}

// ---------- histórico: sem edição ----------
function removerEdicaoHistorico(){
  const v=$('ver-tab-ver');
  if(v&&v.parentElement) v.parentElement.style.display='none';   // some o seletor Ver/Editar
}

// ---------- raios do Fabinho (proporcionais ao tamanho real do card) ----------
function rnd(a,b){return a+Math.random()*(b-a);}
function clampN(v,a,b){return Math.max(a,Math.min(b,v));}
function dPath(pts){return pts.map(function(p,i){return (i?'L':'M')+p.x.toFixed(1)+','+p.y.toFixed(1);}).join(' ');}
function raioPx(x0,w,h){
  const segs=Math.max(3,Math.round(h/7)), jit=Math.max(3,h*0.22);
  const pts=[{x:x0,y:0}]; let x=x0;
  for(let k=1;k<=segs;k++){
    const y=(h/segs)*k+(k<segs?rnd(-h*0.04,h*0.04):0);
    x=clampN(x+rnd(-jit,jit)*(Math.random()<0.25?1.7:1),x0-h*0.9,x0+h*0.9);
    x=clampN(x,2,w-2);
    pts.push({x:x,y:clampN(y,0,h)});
  }
  return pts;
}
function ramoPx(o,dir,h,segs,w){
  const pts=[{x:o.x,y:o.y}]; let x=o.x,y=o.y;
  for(let k=0;k<segs;k++){
    x=clampN(x+dir*rnd(h*0.12,h*0.28)*(1-k*0.15),2,w-2);
    y=clampN(y+rnd(h*0.18,h*0.34),0,h);
    pts.push({x:x,y:y});
  }
  return pts;
}
// monta os 4 raios usando o tamanho REAL do card (w x h em pixels)
function stormSvgConteudo(w,h){
  const fr=[0.1,0.35,0.6,0.85];
  let grupos='', delayPrimeiro='0';
  fr.forEach(function(f,k){
    const x0=clampN(w*f+rnd(-w*0.05,w*0.05),6,w-6);
    const pts=raioPx(x0,w,h);
    const delay=(k*0.65+rnd(0,0.35)).toFixed(2);
    if(k===0) delayPrimeiro=delay;
    const ramos=[]; const usados={};
    const nR=Math.min(2+Math.floor(rnd(0,2)),pts.length-2);
    for(let r=0;r<nR;r++){
      const idx=1+Math.floor(rnd(0,pts.length-2));
      if(usados[idx]) continue; usados[idx]=1;
      const dir=Math.random()<0.5?-1:1;
      const rp=ramoPx(pts[idx],dir,h,2+Math.floor(rnd(0,2)),w);
      ramos.push(dPath(rp));
      if(Math.random()<0.5&&rp.length>2) ramos.push(dPath(ramoPx(rp[2],-dir,h,2,w)));
    }
    const principal=dPath(pts);
    const base='fill="none" stroke-linecap="round" stroke-linejoin="round"';
    let g='<g class="dv-bolt" style="--d:'+delay+'s">';
    g+='<path d="'+principal+'" '+base+' stroke="#4fd8ff" stroke-width="2.2" opacity=".5"/>';
    ramos.forEach(function(d){g+='<path d="'+d+'" '+base+' stroke="#4fd8ff" stroke-width="1.4" opacity=".45"/>';});
    g+='<path d="'+principal+'" '+base+' stroke="#ffffff" stroke-width="1"/>';
    ramos.forEach(function(d){g+='<path d="'+d+'" '+base+' stroke="#d6fbff" stroke-width="0.7"/>';});
    g+='</g>';
    grupos+=g;
  });
  return '<rect class="dv-flash" style="--d:'+delayPrimeiro+'s" x="0" y="0" width="'+w+'" height="'+h+'" fill="#bff6ff"/>'+grupos;
}
// o card só tem tamanho depois de aparecer na tela: aqui os raios são desenhados no tamanho real
function ajustarRaios(){
  document.querySelectorAll('#func-list .storm-svg[data-dv]').forEach(function(svg){
    const card=svg.parentElement; if(!card) return;
    const w=card.clientWidth, h=card.clientHeight;
    if(!w||!h) return;
    if(svg.getAttribute('data-w')===String(w)&&svg.getAttribute('data-h')===String(h)&&svg.childNodes.length) return;
    svg.setAttribute('viewBox','0 0 '+w+' '+h);
    svg.setAttribute('data-w',w); svg.setAttribute('data-h',h);
    svg.innerHTML=stormSvgConteudo(w,h);
  });
}
let rzT=null;
window.addEventListener('resize',function(){clearTimeout(rzT);rzT=setTimeout(ajustarRaios,200);});

const funcCardBase=funcCard;
window.funcCard=function(f,i,ctx){
  let html=funcCardBase(f,i,ctx);
  const nome=String(f.nome||'').trim().toLowerCase();
  if(nome==='fabinho'&&funcStatus(f)==='presente'){
    html=html.replace(/<svg class="storm-svg"[\s\S]*?<\/svg>/,function(){return '<svg class="storm-svg" data-dv="1" preserveAspectRatio="none" aria-hidden="true"></svg>';});
  }
  return html;
};

// ---------- início ----------
async function iniciar(){
  itens=lerJSON(DV_CACHE,{}); logs=lerJSON(LOG_CACHE,{});
  corte();
  // limpa do aparelho o que é de antes do dia de início
  Object.keys(itens).forEach(id=>{if(!valido(itens[id]))delete itens[id];});
  Object.keys(logs).forEach(id=>{if(!(logs[id]&&logs[id].dia>=corte()))delete logs[id];});
  salvarLocal();
  montarPaginaRegistros(); injetarBotoes(); injetarCss(); removerImportar(); prepararFuncCard(); atualizarFuncCard(); removerEdicaoHistorico(); removerEnviarPlanilha(); window.renderDevia();
  await sincronizar(); travarAntigos(); window.renderDevia();
  if(!lerJSON(MIG_FLAG,false)){
    try{await migrar(DIAS_MIGRAR);gravarJSON(MIG_FLAG,true);}catch(e){}
    window.renderDevia();
  }
  const atualizar=async function(){
    if(document.hidden) return;
    const mudou=await sincronizar(); travarAntigos();
    if(mudou&&!modalAberto()){window.renderDevia();dvRenderRegistros();}
  };
  setInterval(atualizar,45000);
  document.addEventListener('visibilitychange',atualizar);
}
iniciar();

})();
