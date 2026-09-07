export const LANDING_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FreeDeepseekAPI — Local Bridge Console</title>
<style>
:root {
  --bg:#020101;--s1:#070605;--s2:#0c0908;
  --bdr:#241713;--bdr-a:#69150D;
  --acc:#FD1000;--acc-d:#AA200F;--acc-m:#69150D;
  --txt:#E5E3E3;--txt-m:#8f8987;
  --ok:#37d67a;--err:#ff5c6c;
  --f:"Segoe UI",-apple-system,Roboto,Helvetica,Arial,sans-serif;
  --m:"Cascadia Code","JetBrains Mono","Fira Code",Consolas,"Courier New",monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{font-family:var(--f);background:var(--bg);color:var(--txt);line-height:1.5;overflow-x:hidden;min-height:100vh}
body::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;background:radial-gradient(ellipse 80% 50% at 50% 0%,rgba(109,21,13,.08) 0%,transparent 60%),radial-gradient(ellipse 60% 40% at 80% 100%,rgba(170,32,15,.04) 0%,transparent 50%)}
body::after{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.025;background-image:linear-gradient(rgba(253,16,0,.3) 1px,transparent 1px),linear-gradient(90deg,rgba(253,16,0,.3) 1px,transparent 1px);background-size:60px 60px}
.app{position:relative;z-index:1;max-width:1280px;margin:0 auto;padding:0 28px}

.hdr{display:flex;align-items:center;justify-content:space-between;padding:14px 0 10px;border-bottom:1px solid var(--bdr)}
.hdr-l{display:flex;align-items:center;gap:14px}
.hdr-brand{font-family:var(--m);font-size:16px;font-weight:700;color:var(--txt);letter-spacing:.5px;display:flex;align-items:center;gap:8px}
.hdr-brand .p{color:var(--acc)}
.hdr-sub{font-family:var(--m);font-size:10px;color:var(--txt-m);letter-spacing:1.5px;text-transform:uppercase}
.hdr-r{display:flex;align-items:center;gap:20px}
.hdr-st{display:flex;align-items:center;gap:7px;font-family:var(--m);font-size:11px;color:var(--txt-m);letter-spacing:.8px}
.dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.dot-ok{background:var(--ok);box-shadow:0 0 8px rgba(55,214,122,.5)}
.dot-bad{background:var(--err);box-shadow:0 0 8px rgba(255,92,108,.5)}
.dot-p{background:var(--txt-m)}
.hdr-ep{font-family:var(--m);font-size:11px;color:var(--txt-m);letter-spacing:.5px}

.art{position:relative;margin:14px 0;border-radius:6px;overflow:hidden;border:1px solid var(--bdr);height:180px}
.art img{width:100%;height:100%;object-fit:cover;filter:brightness(.45) saturate(.7)}
.art-ov{position:absolute;inset:0;background:linear-gradient(180deg,rgba(2,1,1,.3) 0%,rgba(2,1,1,0) 30%,rgba(2,1,1,.6) 100%)}
.art-sc{position:absolute;inset:0;pointer-events:none;opacity:.04;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(253,16,0,.15) 2px,rgba(253,16,0,.15) 4px)}
.art-lbl{position:absolute;top:12px;left:14px;right:14px;display:flex;justify-content:space-between;pointer-events:none}
.art-t{font-family:var(--m);font-size:9.5px;color:var(--txt-m);letter-spacing:1.5px;text-transform:uppercase;opacity:.7}
.art-t span{color:var(--acc)}

.panels{display:grid;grid-template-columns:1fr 1.4fr;gap:16px;margin-bottom:12px}
.pnl{background:var(--s1);border:1px solid var(--bdr);border-radius:6px;padding:18px 20px}
.pnl-h{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.pnl-idx{font-family:var(--m);font-size:10px;color:var(--acc);letter-spacing:1px;font-weight:700}
.pnl-t{font-family:var(--m);font-size:11px;color:var(--txt-m);letter-spacing:1.5px;text-transform:uppercase}

.c-rows{display:flex;flex-direction:column;gap:8px;margin-bottom:14px}
.c-row{display:flex;align-items:center;justify-content:space-between;padding:9px 14px;background:var(--s2);border:1px solid var(--bdr);border-radius:4px}
.c-lbl{font-family:var(--m);font-size:11px;color:var(--txt-m);letter-spacing:.8px;text-transform:uppercase}
.c-val{display:flex;align-items:center;gap:7px;font-family:var(--m);font-size:12px;color:var(--txt)}
.c-btns{display:flex;gap:10px}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;font-family:var(--m);font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;padding:9px 18px;border-radius:4px;border:none;cursor:pointer;transition:all .12s ease;text-decoration:none;white-space:nowrap}
.btn:active{transform:scale(.97)}
.btn:disabled{cursor:not-allowed;opacity:.4;transform:none;box-shadow:none}
.btn-p{background:var(--acc);color:#fff;box-shadow:0 0 20px rgba(253,16,0,.2)}
.btn-p:hover{background:#e00e00;box-shadow:0 0 28px rgba(253,16,0,.35)}
.btn-s{background:transparent;color:var(--txt-m);border:1px solid var(--bdr)}
.btn-s:hover{border-color:var(--bdr-a);color:var(--txt)}
.btn-sm{padding:7px 14px;font-size:10px}

.sess{display:flex;flex-direction:column;gap:12px}
.f-lbl{font-family:var(--m);font-size:10px;color:var(--txt-m);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:5px}
.f-row{display:flex;gap:8px;align-items:stretch}
.f-inp{flex:1;font-family:var(--m);font-size:13px;color:var(--txt);background:var(--s2);border:1px solid var(--bdr);border-radius:4px;padding:9px 12px;outline:none;transition:border-color .15s}
.f-inp:focus{border-color:var(--acc)}
.f-inp::placeholder{color:var(--txt-m);opacity:.5}
.f-hint{font-family:var(--m);font-size:10px;color:var(--txt-m);margin-top:4px;display:flex;align-items:center;gap:6px}
.f-hint .dot{width:5px;height:5px}
select.f-inp{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 5l3 3 3-3' fill='none' stroke='%238f8987' stroke-width='1.5'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;padding-right:32px}
.sess-acts{display:flex;gap:10px;margin-top:2px}

.diag-bar{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.diag-tog{font-family:var(--m);font-size:10px;color:var(--txt-m);letter-spacing:1px;cursor:pointer;background:none;border:none;padding:6px 0;display:flex;align-items:center;gap:6px;transition:color .15s}
.diag-tog:hover{color:var(--acc)}
.diag-tog .arr{transition:transform .2s;display:inline-block}
.diag-tog.open .arr{transform:rotate(90deg)}
.diag-term{background:var(--s1);border:1px solid var(--bdr);border-radius:6px;overflow:hidden;max-height:0;transition:max-height .3s ease,opacity .2s ease;opacity:0}
.diag-term.open{max-height:220px;opacity:1}
.diag-in{padding:14px 16px;font-family:var(--m);font-size:12px;line-height:1.7;overflow-y:auto;max-height:190px}
.diag-ln{display:flex;gap:10px;white-space:nowrap}
.diag-ln .pfx{color:var(--acc);flex-shrink:0}
.diag-ln .lbl{color:var(--txt-m);min-width:120px;flex-shrink:0}
.diag-ln .res{color:var(--ok)}
.diag-ln .res.fail{color:var(--err)}
.diag-ln .res.pnd{color:var(--txt-m)}

.sbar{display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-top:1px solid var(--bdr);font-family:var(--m);font-size:10px;color:var(--txt-m);letter-spacing:1px}
.sbar-l{display:flex;align-items:center;gap:16px}
.sbar-r{opacity:.5;letter-spacing:.5px}

.toast-w{position:fixed;bottom:24px;right:24px;z-index:100;display:flex;flex-direction:column;gap:8px}
.toast{font-family:var(--m);font-size:12px;padding:10px 16px;border-radius:4px;border:1px solid var(--bdr);background:var(--s2);color:var(--txt);box-shadow:0 8px 30px rgba(0,0,0,.5);animation:ti .2s ease}
.toast.error{border-color:var(--err);color:var(--err)}
.toast.success{border-color:var(--ok);color:var(--ok)}
@keyframes ti{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}

@media(max-width:860px){.panels{grid-template-columns:1fr}}
@media(max-width:768px){.app{padding:0 16px}.hdr{flex-wrap:wrap;gap:8px}.hdr-r{gap:12px}.art{height:120px}.c-btns,.sess-acts{flex-wrap:wrap}.sbar{flex-wrap:wrap;gap:8px}}
@media(max-width:480px){.hdr-brand{font-size:13px}.art{height:100px}.pnl{padding:14px 16px}.btn{width:100%}}
</style>
</head>
<body>
<div class="app">
  <header class="hdr">
    <div class="hdr-l">
      <div class="hdr-brand"><span class="p">&gt;_</span> FreeDeepseekAPI</div>
      <div class="hdr-sub">LOCAL BRIDGE // DEEPSEEK WEB</div>
    </div>
    <div class="hdr-r">
      <div class="hdr-st"><span class="dot" id="hdr-led"></span><span id="hdr-stxt">CHECKING</span></div>
      <div class="hdr-ep">127.0.0.1:9655</div>
      <button class="btn btn-s btn-sm" onclick="doLogout()" style="margin-left:8px">LOGOUT</button>
      <button class="btn btn-s btn-sm" onclick="doShutdown()">SHUTDOWN</button>
    </div>
  </header>

  <div class="art">
    <img src="/assets/bridge-network-map.png" alt="Bridge network topology" loading="lazy">
    <div class="art-ov"></div>
    <div class="art-sc"></div>
    <div class="art-lbl">
      <div class="art-t"><span>//</span> NODE_MAP_01</div>
      <div class="art-t">LOCAL NETWORK <span>[ 02:01:01 ]</span></div>
    </div>
  </div>

  <div class="panels">
    <div class="pnl">
      <div class="pnl-h"><span class="pnl-idx">01</span><span class="pnl-t">/ CONNECTION</span></div>
      <div class="c-rows">
        <div class="c-row"><span class="c-lbl">DeepSeek</span><span class="c-val"><span class="dot" id="led-ds"></span><span id="v-ds">CHECKING</span></span></div>
        <div class="c-row"><span class="c-lbl">Bridge</span><span class="c-val"><span class="dot" id="led-br"></span><span id="v-br">CHECKING</span></span></div>
        <div class="c-row"><span class="c-lbl">Health</span><span class="c-val"><span class="dot" id="led-hl"></span><span id="v-hl">&mdash;</span></span></div>
        <div class="c-row"><span class="c-lbl">Readiness</span><span class="c-val"><span class="dot" id="led-rd"></span><span id="v-rd">&mdash;</span></span></div>
      </div>
      <div class="c-btns">
        <button class="btn btn-s btn-sm" onclick="runAuth()">AUTH</button>
        <button class="btn btn-s btn-sm" onclick="runDiagnostics()">DIAGNOSTICS</button>
        <button class="btn btn-s btn-sm" onclick="runDoctor()">RUN DOCTOR</button>
      </div>
      <div class="diag-bar"></div>
      <div class="diag-term" id="diag">
        <div class="diag-in" id="diag-log">
          <div class="diag-ln"><span class="pfx">&gt;</span><span class="lbl">auth.json</span><span class="res pnd">PENDING</span></div>
          <div class="diag-ln"><span class="pfx">&gt;</span><span class="lbl">token</span><span class="res pnd">PENDING</span></div>
          <div class="diag-ln"><span class="pfx">&gt;</span><span class="lbl">session</span><span class="res pnd">PENDING</span></div>
          <div class="diag-ln"><span class="pfx">&gt;</span><span class="lbl">upstream</span><span class="res pnd">PENDING</span></div>
          <div class="diag-ln"><span class="pfx">&gt;</span><span class="lbl">pow_solver</span><span class="res pnd">PENDING</span></div>
          <div class="diag-ln"><span class="pfx">&gt;</span><span class="lbl">streaming</span><span class="res pnd">PENDING</span></div>
        </div>
      </div>
    </div>

    <div class="pnl">
      <div class="pnl-h"><span class="pnl-idx">02</span><span class="pnl-t">/ SESSION</span></div>
      <div class="sess">
        <div>
          <div class="f-lbl">MODEL</div>
          <div class="f-row"><select class="f-inp" id="model-sel"><option value="">LOADING MODELS...</option></select></div>
          <div class="f-hint" id="model-desc"><span class="dot dot-p"></span><span>Select a model</span></div>
        </div>
        <div>
          <div class="f-lbl">WORKING DIRECTORY</div>
          <div class="f-row">
            <input class="f-inp" id="workdir" type="text" placeholder="D:\\Projects\\my-app" value="">
            <button class="btn btn-s btn-sm" id="pick-folder-btn" onclick="pickFolder()" disabled>...</button>
          </div>
          <div class="f-hint" id="wd-status"><span class="dot dot-p"></span><span>Path not verified</span></div>
        </div>
        <div class="sess-acts">
          <button class="btn btn-p btn-sm" id="launch-claude-btn" onclick="launchClaude()" disabled>RUN CLAUDE CODE</button>
          <button class="btn btn-s btn-sm" id="launch-opencode-btn" onclick="launchOpen()" disabled>RUN OPENCODE</button>
        </div>
        <div class="f-hint" id="launch-status"><span class="dot dot-p"></span><span>Checking terminal support</span></div>
      </div>
    </div>
  </div>

  <div class="sbar">
    <div class="sbar-l"><span>&gt; STATUS // <span id="sbar-st">INITIALIZING</span> // LOCAL // NO TELEMETRY</span></div>
    <div class="sbar-r">BRIDGE::LOCAL // <span id="platform-label">DETECTING</span></div>
  </div>
</div>
<div class="toast-w" id="toasts"></div>

<script>
(function(){
  var $=s=>document.getElementById(s);
  var dot_ok="dot dot-ok",dot_bad="dot dot-bad",dot_p="dot dot-p";

  function setLed(id,state,text){
    var el=$(id);if(!el)return;
    var d=el.querySelector(".dot")||el;
    d.className=state==="ok"?dot_ok:state==="bad"?dot_bad:dot_p;
    if(el.nextElementSibling)el.nextElementSibling.textContent=text;
    else{var s=document.getElementById(id.replace("led-","v-"));if(s)s.textContent=text;}
  }
  function setEl(id,cls,text){var e=$(id);if(e){if(cls)e.className=cls;e.textContent=text;}}

  function showToast(msg,type){
    var w=$("toasts"),d=document.createElement("div");
    d.className="toast "+(type||"");
    d.textContent=msg;
    w.appendChild(d);
    setTimeout(function(){d.style.opacity="0";d.style.transition="opacity .3s";setTimeout(function(){d.remove();},300);},5000);
  }

  var models=[];
  var diagOpen=false;
  var activeSSE=null;
  var systemCaps=null;

  function applySystemCapabilities(d){
    systemCaps=d;
    var platform=$("platform-label");
    if(platform)platform.textContent=String(d.platform||"unknown").toUpperCase();
    var picker=$("pick-folder-btn");
    if(picker){picker.disabled=!d.folderPicker;picker.title=d.folderPicker?"Choose folder":"Folder picker unavailable; enter path manually";}
    var hint=$("wd-status");
    if(hint){
      if(d.folderPicker)hint.innerHTML='<span class="dot dot-ok"></span><span>System folder picker available</span>';
      else hint.innerHTML='<span class="dot dot-p"></span><span>Folder picker unavailable on '+String(d.platform||"this platform")+'; enter path manually</span>';
    }
    var claude=$("launch-claude-btn"),open=$("launch-opencode-btn");
    if(claude){claude.disabled=!d.claudeCodeLaunch;claude.title=d.claudeCodeLaunch?"":"Start Claude Code manually in a terminal";}
    if(open){open.disabled=!d.openCodeLaunch;open.title=d.openCodeLaunch?"":"Start OpenCode manually in a terminal";}
    var launchHint=$("launch-status");
    if(launchHint){
      if(d.claudeCodeLaunch||d.openCodeLaunch)launchHint.innerHTML='<span class="dot dot-ok"></span><span>Visible terminal launch available</span>';
      else if(d.platform==="linux")launchHint.innerHTML='<span class="dot dot-p"></span><span>No supported terminal emulator found</span>';
      else if(d.platform==="darwin")launchHint.innerHTML='<span class="dot dot-p"></span><span>Terminal.app or osascript unavailable</span>';
      else launchHint.innerHTML='<span class="dot dot-p"></span><span>Terminal launch unavailable</span>';
    }
  }

  function updateSystem(){
    fetch("/api/system").then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);return r.json();})
      .then(applySystemCapabilities)
      .catch(function(){applySystemCapabilities({platform:"unknown",folderPicker:false,claudeCodeLaunch:false,openCodeLaunch:false});});
  }

  function toggleDiag(){
    diagOpen=!diagOpen;
    var el=$("diag"),tog=document.querySelector(".diag-tog");
    if(diagOpen){el.classList.add("open");if(tog)tog.classList.add("open");}
    else{el.classList.remove("open");if(tog)tog.classList.remove("open");}
  }
  window.toggleDiag=toggleDiag;

  function listenSSE(url,body,onEvent,onDone){
    if(activeSSE){activeSSE.abort();activeSSE=null;}
    var ctrl=new AbortController();
    activeSSE=ctrl;
    fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body||{}),signal:ctrl.signal})
      .then(function(r){var reader=r.body.getReader();var dec=new TextDecoder();var buf="";
        function pump(){return reader.read().then(function(result){
          if(result.done){activeSSE=null;if(onDone)onDone();return;}
          buf+=dec.decode(result.value,{stream:true});
          var lines=buf.split("\\n");buf=lines.pop()||"";
          for(var i=0;i<lines.length;i++){
            var line=lines[i];
            if(!line.startsWith("data: "))continue;
            var payload=line.slice(6);
            if(payload==="[DONE]"){activeSSE=null;if(onDone)onDone();return;}
            try{onEvent(JSON.parse(payload));}catch(ex){}
          }
          return pump();
        });}
        return pump();
      })
      .catch(function(e){activeSSE=null;if(e.name!=="AbortError")showToast("Error: "+e.message,"error");});
    return ctrl;
  }

  /* ── AUTH ── */
  window.runAuth=function(){
    showToast("Checking auth...","success");
    listenSSE("/bridge/auth",{},function(ev){
      if(ev.type==="progress"&&ev.step==="chrome")showToast(ev.message||"Starting Chrome...","success");
      if(ev.type==="progress"&&ev.step==="auth")showToast(ev.message||"Waiting for login...","success");
      if(ev.type==="result"&&ev.ok){showToast(ev.message||"Auth OK!","success");updateHealth();updateAuthLed();}
      if(ev.type==="error")showToast(ev.message||"Auth failed","error");
    },function(){});
  };

  /* ── DIAGNOSTICS (quick, local) ── */
  window.runDiagnostics=function(){
    if(!diagOpen)toggleDiag();
    var log=$("diag-log");
    var checks=["auth_file","upstream","bridge_server","data_dir"];
    var labels={auth_file:"auth.json",upstream:"deepseek reachable",bridge_server:"bridge server",data_dir:"data directory"};
    var rows={};
    log.innerHTML="";
    checks.forEach(function(n){
      var row=document.createElement("div");
      row.className="diag-ln";
      row.innerHTML='<span class="pfx">&gt;</span><span class="lbl">'+(labels[n]||n)+'</span><span class="res pnd">PENDING</span>';
      log.appendChild(row);
      rows[n]=row;
    });
    showToast("Running diagnostics...","success");
    listenSSE("/bridge/diagnostics",{},function(ev){
      if(ev.type==="progress"&&ev.step){
        var row=rows[ev.step];
        if(row){
          var res=row.querySelector(".res");
          if(ev.ok===true){res.className="res";res.textContent="OK";}
          else if(ev.ok===false){res.className="res fail";res.textContent="FAIL: "+(ev.message||"");}
          else{res.className="res pnd";res.textContent=ev.message||"...";}
        }
      }
      if(ev.type==="result"){
        showToast(ev.ok?"Diagnostics passed":ev.message||"Diagnostics done",ev.ok?"success":"error");
        updateHealth();updateAuthLed();
      }
      if(ev.type==="error")showToast(ev.message||"Error","error");
    },function(){});
  };

  /* ── RUN DOCTOR (full upstream validation) ── */
  window.runDoctor=function(){
    if(!diagOpen)toggleDiag();
    var log=$("diag-log");
    var checks=["auth file present","deepseek reachable","pow challenge","pow solved","completion SSE parsed","completion content"];
    var rows={};
    log.innerHTML="";
    checks.forEach(function(n){
      var row=document.createElement("div");
      row.className="diag-ln";
      row.innerHTML='<span class="pfx">&gt;</span><span class="lbl">'+n+'</span><span class="res pnd">PENDING</span>';
      log.appendChild(row);
      rows[n]=row;
    });
    showToast("Running full doctor checks...","success");
    listenSSE("/bridge/doctor",{},function(ev){
      if(ev.type==="progress"&&ev.step){
        var row=rows[ev.step];
        if(row){
          var res=row.querySelector(".res");
          if(ev.ok===true){res.className="res";res.textContent="OK";}
          else if(ev.ok===false){res.className="res fail";res.textContent="FAIL: "+(ev.message||"");}
          else{res.className="res pnd";res.textContent=ev.message||"...";}
        }
      }
      if(ev.type==="result"){
        showToast(ev.ok?"All checks passed":ev.message||"Some checks failed",ev.ok?"success":"error");
        updateHealth();updateAuthLed();
      }
      if(ev.type==="error")showToast(ev.message||"Error","error");
    },function(){});
  };

  /* ── LAUNCH ── */
  function launch(tool){
    if(systemCaps&&((tool==="claude"&&!systemCaps.claudeCodeLaunch)||(tool==="opencode"&&!systemCaps.openCodeLaunch))){showToast(systemCaps.platform==="linux"?"No supported terminal emulator found":"Native terminal launch is unavailable. Start the CLI manually.","error");return;}
    var wd=$("workdir");
    var workDir=wd?wd.value.trim():"";
    if(!workDir){showToast("Enter working directory first","error");return;}
    var md=$("model-sel");
    var model=md?md.value:"deepseek-v4-flash";
    showToast("Launching "+tool+"...","success");
    listenSSE("/bridge/launch",{tool:tool,workDir:workDir,model:model},function(ev){
      if(ev.type==="progress")showToast(ev.message||"...","success");
      if(ev.type==="log"&&ev.message)console.log("[bridge]",ev.message);
      if(ev.type==="result")showToast(ev.message||"Finished",ev.ok?"success":"error");
      if(ev.type==="error")showToast(ev.message||"Launch error","error");
    },function(){});
  }
  window.launchClaude=function(){launch("claude");};
  window.launchOpen=function(){launch("opencode");};
  window.pickFolder=function(){
    if(systemCaps&&!systemCaps.folderPicker){showToast("Folder picker unavailable; enter path manually","info");return;}
    fetch("/bridge/pick-folder",{method:"POST",headers:{"content-type":"application/json"},body:"{}"})
      .then(function(r){return r.json();}).then(function(d){
        if(d.path){var inp=$("workdir");if(inp)inp.value=d.path;showToast("Folder selected","success");}
        else if(d.cancelled){}
        else{showToast(d.message||"Enter path manually","info");}
      }).catch(function(){showToast("Folder picker failed","error");});
  };

  window.doLogout=function(){
    if(!confirm("Logout from DeepSeek?"))return;
    fetch("/bridge/logout",{method:"POST",headers:{"content-type":"application/json"},body:"{}"})
      .then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error(d.message||"Logout failed");return d;});}).then(function(){
        showToast("Logged out","success");updateHealth();updateAuthLed();
      }).catch(function(e){showToast(e.message||"Logout failed","error");});
  };

  window.doShutdown=function(){
    fetch("/bridge/shutdown",{method:"POST",headers:{"content-type":"application/json"},body:"{}"})
      .then(function(r){return r.json();}).then(function(){
        document.body.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:var(--m);color:var(--txt)"><div style="text-align:center"><div style="font-size:18px;margin-bottom:12px">Shutdown accepted.</div><div style="color:var(--txt-m);font-size:13px">Bridge is shutting down. You can close this tab.</div></div></div>';
        try{window.close();}catch(ex){}
      }).catch(function(){showToast("Shutdown failed","error");});
  };

  /* ── POLLING ── */
  function updateAuthLed(){
    fetch("/bridge/auth-status").then(function(r){return r.json();}).then(function(d){
      if(d.valid)setLed("led-ds","ok","CONNECTED");
      else setLed("led-ds","bad","NO AUTH");
    }).catch(function(){setLed("led-ds","pnd","UNKNOWN");});
  }

  function updateHealth(){
    fetch("/health").then(function(r){return r.json();}).then(function(){
      setEl("v-hl","c-val","OK");setLed("led-hl","ok","OK");
      setEl("hdr-led","","");setEl("hdr-stxt","","ONLINE");
      setLed("led-br","ok","READY");
      setEl("sbar-st","","READY");
      updateAuthLed();
    }).catch(function(){
      setEl("v-hl","","ERROR");setLed("led-hl","bad","ERROR");
      setEl("hdr-led","","");setEl("hdr-stxt","","OFFLINE");
      setLed("led-br","bad","DOWN");
      setLed("led-ds","pnd","UNKNOWN");
      setEl("sbar-st","","OFFLINE");
    });
  }

  function updateReady(){
    fetch("/readyz").then(function(r){if(r.ok){setEl("v-rd","","OK");setLed("led-rd","ok","OK");}else{setEl("v-rd","","NOT READY");setLed("led-rd","bad","NOT READY");}}).catch(function(){setEl("v-rd","","ERROR");setLed("led-rd","bad","ERROR");});
  }

  function updateModels(){
    fetch("/v1/models").then(function(r){return r.json();}).then(function(d){
      models=d.data||d.models||[];
      var sel=$("model-sel");
      sel.innerHTML="";
      if(!models.length){sel.innerHTML="<option>NO MODELS</option>";return;}
      models.forEach(function(m,i){
        var o=document.createElement("option");
        o.value=m.id||m; o.textContent=m.id||m;
        if(i===0)o.selected=true;
        sel.appendChild(o);
      });
      var desc=$("model-desc");
      if(desc)desc.innerHTML='<span class="dot dot-ok"></span><span>'+models.length+' model(s) available</span>';
    }).catch(function(){
      var sel=$("model-sel");
      sel.innerHTML="<option>DEEPSEEK-V4-FLASH</option><option>DEEPSEEK-V4-PRO</option>";
    });
  }

  updateSystem();
  updateHealth();
  updateReady();
  updateModels();
  setInterval(updateHealth,5000);
  setInterval(updateReady,7000);
})();
</script>
</body>
</html>`;
