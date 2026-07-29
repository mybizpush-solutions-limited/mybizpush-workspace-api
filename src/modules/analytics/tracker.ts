// The tracking snippet served at GET /px.js. Kept dependency-free and small so
// it can be dropped onto any of our sites with a single <script> tag:
//
//   <script defer src="https://<api-host>/px.js" data-site="PUBLIC_KEY"></script>
//
// It reports the initial pageview, follows SPA route changes (pushState /
// replaceState / popstate), and flushes time-on-page with sendBeacon on unload.
// Custom events: window.mbp("signup_clicked", { plan: "pro" }).
export function trackerScript(collectUrl: string): string {
  return `(function(){
  var s=document.currentScript;
  if(!s)return;
  var key=s.getAttribute("data-site");
  if(!key)return;
  var endpoint=${JSON.stringify(collectUrl)};
  var sid=Math.random().toString(36).slice(2)+Date.now().toString(36);
  // Feature-detect once: Request honours "keepalive" in every current browser.
  var supportsKeepalive=(function(){try{return "keepalive" in new Request("");}catch(e){return false;}})();
  var lastPath=null,enteredAt=Date.now();

  function send(body,beacon){
    body.k=key;body.s=sid;
    try{
      var json=JSON.stringify(body);
      // fetch+keepalive survives page unload exactly like sendBeacon, but lets
      // us send credentials:"omit". That matters: sendBeacon is ALWAYS
      // credentials:"include", and the collector reflects arbitrary origins, so
      // it can't legally answer with allow-credentials. An uncredentialed
      // request sidesteps the whole problem. text/plain keeps it a "simple"
      // request, so there's no preflight either.
      if(supportsKeepalive){
        fetch(endpoint,{method:"POST",body:json,headers:{"Content-Type":"text/plain;charset=UTF-8"},keepalive:true,mode:"cors",credentials:"omit"}).catch(function(){});
      }else if(navigator.sendBeacon){
        navigator.sendBeacon(endpoint,new Blob([json],{type:"text/plain;charset=UTF-8"}));
      }
    }catch(e){}
  }

  function flush(){
    if(lastPath===null)return;
    var d=Date.now()-enteredAt;
    if(d<250)return;
    send({t:"duration",u:lastPath,d:d},true);
  }

  function view(){
    var path=location.pathname+location.search;
    if(path===lastPath)return;
    flush();
    lastPath=path;enteredAt=Date.now();
    send({t:"pageview",u:path,r:document.referrer||"",w:screen.width||0});
  }

  function wrap(name){
    var orig=history[name];
    if(typeof orig!=="function")return;
    history[name]=function(){var r=orig.apply(this,arguments);view();return r;};
  }
  wrap("pushState");wrap("replaceState");
  addEventListener("popstate",view);
  addEventListener("visibilitychange",function(){if(document.visibilityState==="hidden")flush();});
  addEventListener("pagehide",flush);

  window.mbp=function(name,props){
    send({t:"event",n:String(name).slice(0,80),u:location.pathname,p:props||{}});
  };

  view();
})();`;
}
