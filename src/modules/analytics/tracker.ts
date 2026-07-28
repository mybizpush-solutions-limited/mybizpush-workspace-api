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
  var lastPath=null,enteredAt=Date.now();

  function send(body,beacon){
    body.k=key;body.s=sid;
    try{
      var json=JSON.stringify(body);
      if(beacon&&navigator.sendBeacon){
        navigator.sendBeacon(endpoint,new Blob([json],{type:"application/json"}));
      }else{
        fetch(endpoint,{method:"POST",body:json,headers:{"Content-Type":"application/json"},keepalive:true,mode:"cors",credentials:"omit"}).catch(function(){});
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
