(function(){
'use strict';

// ---------- configuração ----------
const DV_PATH='pizzaria_devias';      // lista única e permanente
const LOG_PATH='pizzaria_log';        // aba de Registros (só acrescenta)
const DV_CACHE='piz_dv_cache', LOG_CACHE='piz_log_cache', OUTBOX='piz_dv_outbox', MIG_FLAG='piz_dv_migrado';
const DIAS_ANTIGA=7;                  // pendente com mais de 7 dias vai pra "Pendentes antigas"
const DIAS_MIGRAR=7;                  // na 1ª vez, traz as anotações dos últimos 7 dias

let itens={}, logs={};
let antigasAbertas={devemos:false,devem:false};
let regTab='log', origemReg='home';

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
function diaMenos(n){const [y,m,d]=hoje().split('-').map(Number);const dt=new Date(y,m-1,d-n);return dt.getFullYear()+'-'+pad(dt.getMonth()+1)+'-'+pad(dt.getDate());}
function modalAberto(){return !!document.querySelector('.modal-bg[style*="flex"]');}

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
        else if((res.status===401||res.status===403)&&!op.q) setStatusSafe('⚠️ O Firebase recusou uma gravação (confira as regras)','#f59e0b');
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

async function sincronizar(){
  try{
    await fluxo();
    const [r,l]=await Promise.all([firebaseGet(DV_PATH),firebaseGet(LOG_PATH)]);
    const pend=lerJSON(OUTBOX,[]).length>0;
    const nI=pend?{...(r||{}),...itens}:(r||{});
    const nL=pend?{...(l||{}),...logs}:(l||{});
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
  const it={id:novoId('d'),tipo:tipo==='devem'?'devem':'devemos',nome:nome,val:Number(val)||0,det:det||'',criadoEm:agora(),criadoDia:hoje(),pago:false};
  itens[it.id]=it; salvarLocal();
  remoto('PUT',DV_PATH+'/'+it.id,it);
  registrar('criado',it,'',resumo(it));
  return it;
}
window.dvMarcar=function(id,pago){
  const it=itens[id];
  if(!it||it.travado||it.cancelado){renderDevia();return;}
  if(pago){
    it.pago=true;it.pagoEm=agora();it.pagoDia=hoje();
    remoto('PATCH',DV_PATH+'/'+id,{pago:true,pagoEm:it.pagoEm,pagoDia:it.pagoDia});
    registrar('pago',it,'pendente','pago');
  } else {
    if(it.pagoDia!==hoje()){alert('Essa anotação foi paga em outro dia e não pode mais ser desmarcada.');renderDevia();return;}
    if(!confirm('Desmarcar como pago? Isso fica registrado.')){renderDevia();return;}
    it.pago=false;delete it.pagoEm;delete it.pagoDia;
    remoto('PATCH',DV_PATH+'/'+id,{pago:false,pagoEm:null,pagoDia:null});
    registrar('desmarcado',it,'pago','pendente');
  }
  salvarLocal(); renderDevia(); dvRenderRegistros();
};
function dvEditar(id,campos){
  const it=itens[id]; if(!it||it.travado||it.cancelado) return;
  const antes=resumo(it);
  const novo={nome:campos.nome,val:Number(campos.val)||0,tipo:campos.tipo==='devem'?'devem':'devemos'};
  if(novo.nome===it.nome&&novo.val===it.val&&novo.tipo===it.tipo) return;
  Object.assign(it,novo); salvarLocal();
  remoto('PATCH',DV_PATH+'/'+id,novo);
  registrar('editado',it,antes,resumo(it));
}
window.dvCancelar=function(id){
  const it=itens[id]; if(!it||it.travado||it.cancelado) return;
  const motivo=(prompt('Por que cancelar "'+primeiraLinha(it.nome)+'"? (obrigatório)')||'').trim();
  if(!motivo){alert('Cancelamento exige um motivo.');return;}
  it.cancelado=true;it.cancelEm=agora();it.cancelMotivo=motivo;it.travado=true;
  salvarLocal();
  remoto('PATCH',DV_PATH+'/'+id,{cancelado:true,cancelEm:it.cancelEm,cancelMotivo:motivo,travado:true});
  registrar('cancelado',it,resumo(it),'',motivo);
  renderDevia(); dvRenderRegistros();
};
window.dvAbrirEdicao=function(id){const it=itens[id];if(!it||it.travado)return;window._openModalDevia(id,'main',it);};
window.dvToggleAntigas=function(tipo){antigasAbertas[tipo]=!antigasAbertas[tipo];renderDevia();};

// Paga em dia anterior => trava de vez (histórico inalterável)
function travarAntigos(){
  const h=hoje();
  Object.values(itens).forEach(it=>{
    if(!it.travado&&it.pago&&it.pagoDia&&it.pagoDia<h){
      it.travado=true; remoto('PATCH',DV_PATH+'/'+it.id,{travado:true},true);
    }
  });
  salvarLocal();
}

// ---------- tela: cards e listas ----------
function cartao(it){
  const devem=it.tipo==='devem', bloq=!!it.travado;
  const corVal=devem?'var(--red)':'var(--green)';
  const info='lançado '+fmtHora(it.criadoEm)+(it.pago&&it.pagoEm?' · pago '+fmtHora(it.pagoEm):'');
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
function agrupar(lista){
  const m=new Map();
  lista.forEach(i=>{const k=normalizaNome(primeiraLinha(i.nome))||i.id;if(!m.has(k))m.set(k,[]);m.get(k).push(i);});
  return [...m.values()];
}
function soma(l){return l.reduce((s,i)=>s+(Number(i.val)||0),0);}

function montarLista(tipo){
  const termo=termoBuscaGlobal();
  const h=hoje(), limite=agora()-DIAS_ANTIGA*864e5;
  let todos=Object.values(itens).filter(i=>i.tipo===tipo&&!i.cancelado);
  if(termo) todos=todos.filter(i=>(i.nome||'').toLowerCase().includes(termo)||(i.det||'').toLowerCase().includes(termo));
  // some da tela só quando foi pago em dia anterior (vai pro histórico)
  const ativos=todos.filter(i=>!i.pago||i.pagoDia===h);
  const antigas=ativos.filter(i=>!i.pago&&i.criadoEm<limite).sort((a,b)=>a.criadoEm-b.criadoEm);
  const principais=ativos.filter(i=>!(!i.pago&&i.criadoEm<limite)).sort((a,b)=>b.criadoEm-a.criadoEm);
  if(!principais.length&&!antigas.length)
    return termo?'<div class="empty">Nenhum resultado para "'+escapeHTML(termo)+'".</div>':'<div class="empty">Nada aqui ainda.</div>';
  let html=principais.map(cartao).join('');
  if(antigas.length){
    const aberto=antigasAbertas[tipo]||!!termo;
    html+='<div onclick="dvToggleAntigas(\''+tipo+'\')" style="cursor:pointer;font-size:12px;font-weight:700;color:var(--orange);padding:8px 10px;margin:6px 0;border:1px dashed var(--orange);border-radius:7px;display:flex;justify-content:space-between;">'+
      '<span>'+(aberto?'▾':'▸')+' Pendentes antigas ('+antigas.length+')</span><span>R$ '+fmt(soma(antigas))+'</span></div>';
    if(aberto){
      agrupar(antigas).forEach(g=>{
        html+='<div style="font-size:11px;font-weight:700;color:var(--muted);margin:8px 0 4px;">'+escapeHTML(primeiraLinha(g[0].nome))+' — R$ '+fmt(soma(g))+' ('+g.length+')</div>'+g.map(cartao).join('');
      });
    }
  }
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
  const arr=Object.values(itens).filter(i=>!i.cancelado&&i.criadoDia<=dk&&(!i.pago||i.pagoDia>=dk)).sort((a,b)=>a.criadoEm-b.criadoEm);
  const linha=i=>i.nome+(i.val?' - R$ '+fmt(i.val):'')+(i.det?' - '+i.det:'')+
    (i.criadoDia<dk?' (anotado '+fmtHora(i.criadoEm)+')':'')+(i.pago&&i.pagoDia===dk?' ✔ PAGO':'');
  let t='';
  const dv=arr.filter(i=>i.tipo==='devemos'), de=arr.filter(i=>i.tipo==='devem');
  if(dv.length) t+='DEVEMOS:\n'+dv.map(linha).join('\n')+'\n\n';
  if(de.length) t+='DEVEM:\n'+de.map(linha).join('\n')+'\n';
  return t.trim();
}
window.gerarTexto=function(st,dk){
  const base=gerarTextoBase(st,dk);
  if(st&&st.devias&&st.devias.length) return base;      // dia antigo (formato anterior): como era
  const extra=textoAnotacoes(dk);
  return extra?(base+'\n\n'+extra).trim():base;
};

// Importar texto colado: anotações importadas entram na lista permanente
const confirmarImportBase=confirmarImport;
window.confirmarImport=function(){
  confirmarImportBase();
  if(typeof editandoHistorico!=='undefined'&&editandoHistorico) return;
  if(currentDate!==hoje()) return;
  const pend=(state.devias||[]).slice();
  if(!pend.length) return;
  pend.forEach(d=>dvCriar(d.tipo==='devem'?'devem':'devemos',d.nome,d.val,d.det||''));
  state.devias=[]; window.renderDevia(); save();
};

// ---------- trazer anotações dos relatórios antigos ----------
async function migrar(dias){
  const keys=await window._loadAllKeys();
  const limite=diaMenos(dias), h=hoje();
  let novos=0;
  for(const k of keys){
    if(k<limite) continue;
    const st=(currentDate===k&&state)?state:window._getCached(k);
    if(!st||!st.devias||!st.devias.length) continue;
    const [y,m,dd]=k.split('-').map(Number);
    st.devias.forEach((d,idx)=>{
      const id='m_'+k+'_'+idx;
      if(itens[id]) return;
      const it={id,tipo:d.tipo==='devem'?'devem':'devemos',nome:d.nome||'',val:Number(d.val)||0,det:d.det||'',
        criadoEm:new Date(y,m-1,dd,12,0).getTime(),criadoDia:k,pago:false,migrado:true};
      itens[id]=it; remoto('PUT',DV_PATH+'/'+id,it); novos++;
    });
    // hoje: a lista do dia passa a ser só a permanente
    if(k===h){
      if(currentDate===k&&state){state.devias=[];window._save(k,state);}
      else{const s2=await window._load(k);if(s2){s2.devias=[];await window._save(k,s2);}}
    }
  }
  salvarLocal();
  if(novos) registrar('migracao',null,'',novos+' anotação(ões) trazida(s) dos relatórios dos últimos '+dias+' dias');
  return novos;
}
window.dvTrazerAntigas=async function(){
  const r=prompt('Trazer anotações dos relatórios dos últimos quantos dias? (ex: 30)\n\nAtenção: elas chegam como PENDENTES. Confira se não foram pagas.','30');
  const n=parseInt(r,10); if(!n||n<1) return;
  const q=await migrar(n); window.renderDevia(); dvRenderRegistros();
  alert(q?('✅ '+q+' anotação(ões) trazida(s).'):'Nada novo para trazer.');
};

// ---------- aba Registros ----------
function montarPaginaRegistros(){
  const p=document.createElement('div'); p.className='page'; p.id='page-reg';
  p.innerHTML=
   '<div class="ctr" style="padding-top:16px;">'+
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">'+
      '<button class="btn btn-gray" onclick="dvVoltarRegistros()">←</button>'+
      '<div style="font-size:16px;font-weight:700;">📜 Registros</div></div>'+
    '<div style="display:flex;gap:4px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:3px;margin-bottom:12px;">'+
      '<button id="reg-tab-log" class="btn btn-green" onclick="dvRegTab(\'log\')" style="flex:1;border-radius:7px;">Alterações</button>'+
      '<button id="reg-tab-pagos" class="btn btn-gray" onclick="dvRegTab(\'pagos\')" style="flex:1;border-radius:7px;">Pagos</button></div>'+
    '<input type="text" id="reg-busca" class="func-search" placeholder="🔍 Buscar por nome..." oninput="dvRenderRegistros()"/>'+
    '<div id="reg-conteudo"></div>'+
    '<div class="btn-row"><button class="btn btn-orange" onclick="dvTrazerAntigas()">📥 Trazer anotações de relatórios mais antigos</button></div>'+
    '<div style="font-size:11px;color:var(--muted);margin-top:10px;line-height:1.5;">Os registros só acumulam: nada aqui pode ser editado ou apagado pelo app.</div>'+
   '</div>';
  document.body.appendChild(p);
}
window.dvAbrirRegistros=function(){
  origemReg=($('page-rel')&&$('page-rel').classList.contains('active'))?'rel':'home';
  showPage('page-reg'); dvRenderRegistros();
};
window.dvVoltarRegistros=function(){ if(origemReg==='rel') showPage('page-rel'); else irHome(); };
window.dvRegTab=function(t){
  regTab=t;
  $('reg-tab-log').className='btn '+(t==='log'?'btn-green':'btn-gray');
  $('reg-tab-pagos').className='btn '+(t==='pagos'?'btn-green':'btn-gray');
  $('reg-tab-log').style.cssText=$('reg-tab-pagos').style.cssText='flex:1;border-radius:7px;';
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
    let l=Object.values(logs).sort((a,b)=>b.ts-a.ts)
      .filter(e=>!termo||(e.nome||'').toLowerCase().includes(termo)||(e.motivo||'').toLowerCase().includes(termo));
    const total=l.length; l=l.slice(0,150);
    el.innerHTML=l.length?l.map(e=>{const d=descLog(e);
      return '<div class="item-card"><div class="item-left"><div style="font-size:10px;color:var(--muted);">'+fmtHora(e.ts)+'</div>'+
             '<div style="font-size:12px;color:'+d.cor+';">'+d.txt+'</div></div></div>';}).join('')+
      (total>150?'<div class="empty">Mostrando os 150 mais recentes de '+total+'. Use a busca para achar outros.</div>':'')
      :'<div class="empty">Nenhum registro ainda.</div>';
  } else {
    const pagos=Object.values(itens).filter(i=>i.pago&&!i.cancelado&&(!termo||(i.nome||'').toLowerCase().includes(termo)));
    if(!pagos.length){el.innerHTML='<div class="empty">Nenhum pagamento registrado ainda.</div>';return;}
    const grupos=agrupar(pagos).sort((a,b)=>Math.max(...b.map(i=>i.pagoEm||0))-Math.max(...a.map(i=>i.pagoEm||0)));
    el.innerHTML=grupos.map(g=>
      '<details class="item-card" style="display:block;">'+
        '<summary style="cursor:pointer;font-size:13px;font-weight:700;">'+escapeHTML(primeiraLinha(g[0].nome))+
        ' <span style="color:var(--muted);font-weight:500;">— '+g.length+' pago(s) · R$ '+fmt(soma(g))+'</span></summary>'+
        g.sort((a,b)=>(b.pagoEm||0)-(a.pagoEm||0)).map(i=>
          '<div style="font-size:12px;padding:5px 0;border-bottom:1px dashed var(--border);">R$ '+fmt(i.val)+
          ' · lançado '+fmtHora(i.criadoEm)+' · <span style="color:var(--green);">pago '+(i.pagoEm?fmtHora(i.pagoEm):'?')+'</span>'+(i.travado?' 🔒':'')+'</div>').join('')+
      '</details>').join('');
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
    b.textContent='📜'; b.title='Registros e histórico de pagos'; b.onclick=function(){dvAbrirRegistros();};
    tit.appendChild(b);
  }
}

// ---------- início ----------
async function iniciar(){
  itens=lerJSON(DV_CACHE,{}); logs=lerJSON(LOG_CACHE,{});
  montarPaginaRegistros(); injetarBotoes(); window.renderDevia();
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
