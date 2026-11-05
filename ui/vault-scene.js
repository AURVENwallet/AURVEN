import * as T from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {FLOW_LINKS} from './flow-topology.js?v=3';

const clamp = T.MathUtils.clamp;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const v = (x,y,z) => new T.Vector3(x,y,z);

// Procedural geometry only: all objects, materials and lights are kept local.
export function createVaultScene({canvas,kind='hero',onSelect=()=>{},onAutoStop=()=>{}}) {
  const host=canvas.closest('.scene-host');
  const renderer=new T.WebGLRenderer({canvas,alpha:true,antialias:true,powerPreference:'low-power'});
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.65));
  renderer.setClearColor(0x090b0d,0);
  renderer.shadowMap.enabled=true;
  renderer.shadowMap.type=T.PCFShadowMap;
  renderer.toneMapping=T.ACESFilmicToneMapping;
  renderer.toneMappingExposure=1.0;
  const scene=new T.Scene();
  scene.fog=new T.Fog(0x090b0d,16,34);
  const camera=new T.PerspectiveCamera(35,1,.1,80);
  const controls=new OrbitControls(camera,canvas);
  controls.enablePan=false;
  controls.enableDamping=false;
  controls.rotateSpeed=.55;
  controls.zoomSpeed=.6;
  controls.minPolarAngle=.55;
  controls.maxPolarAngle=1.45;
  controls.minAzimuthAngle=-.85;
  controls.maxAzimuthAngle=1.25;
  canvas.style.touchAction='pan-y';
  const pmrem=new T.PMREMGenerator(renderer);
  const room=new RoomEnvironment();
  const environment=pmrem.fromScene(room,.04);
  scene.environment=environment.texture;
  scene.environmentIntensity=.64;
  room.dispose();pmrem.dispose();
  const light=new T.DirectionalLight(0xffffff,2.7);light.position.set(-3,7,5);light.castShadow=true;
  light.shadow.mapSize.set(1536,1536);light.shadow.camera.left=-7;light.shadow.camera.right=7;
  light.shadow.camera.top=6;light.shadow.camera.bottom=-6;light.shadow.normalBias=.035;light.shadow.bias=-.00015;
  scene.add(light);
  const edge=new T.DirectionalLight(0xffdc91,3.0);edge.position.set(5,4,-4);scene.add(edge);
  const fill=new T.DirectionalLight(0xbccad4,.7);fill.position.set(-4,3,-2);scene.add(fill);
  scene.add(new T.HemisphereLight(0xe9edef,0x272117,.45));
  const mats={
    graphite:new T.MeshStandardMaterial({color:0x272d31,metalness:.9,roughness:.32}),
    black:new T.MeshStandardMaterial({color:0x111619,metalness:.65,roughness:.4}),
    steel:new T.MeshStandardMaterial({color:0x939993,metalness:1,roughness:.23}),
    silver:new T.MeshStandardMaterial({color:0xe0dfd5,metalness:1,roughness:.22}),
    gold:new T.MeshStandardMaterial({color:0xd8a326,metalness:.84,roughness:.26}),
    glow:new T.MeshStandardMaterial({color:0xffbf07,emissive:0xffae00,emissiveIntensity:.65,metalness:.35,roughness:.24}),
    proof:new T.MeshStandardMaterial({color:0xd9e5e8,emissive:0x9ba9b0,emissiveIntensity:.25,metalness:.6,roughness:.2}),
    fee:new T.MeshStandardMaterial({color:0xb58b50,emissive:0x98662d,emissiveIntensity:.25,metalness:.6,roughness:.35}),
    receipt:new T.MeshStandardMaterial({color:0xacc2cc,emissive:0x8eacb9,emissiveIntensity:.3,metalness:.4,roughness:.3}),
    glass:new T.MeshPhysicalMaterial({color:0xf5b315,metalness:.1,roughness:.16,clearcoat:1,clearcoatRoughness:.1,transparent:true,opacity:.26,depthWrite:false,emissive:0xbb7800,emissiveIntensity:.18}),
    failure:new T.MeshStandardMaterial({color:0xec8874,emissive:0xbb3928,emissiveIntensity:.45,metalness:.4,roughness:.3})
  };
  // Fine directional roughness is generated once, with no external texture files.
  const brushedData=new Uint8Array(128*128*4);
  for(let y=0;y<128;y++)for(let x=0;x<128;x++){
    const n=((x*73+y*19)^(x*11+y*107))%41;
    const value=Math.round(174+35*Math.sin(x*1.7)+n);
    const i=(y*128+x)*4;brushedData[i]=brushedData[i+1]=brushedData[i+2]=value;brushedData[i+3]=255;
  }
  const brushed=new T.DataTexture(brushedData,128,128,T.RGBAFormat);
  brushed.wrapS=brushed.wrapT=T.RepeatWrapping;brushed.repeat.set(2,2);brushed.needsUpdate=true;
  for(const name of ['steel','silver','graphite'])mats[name].roughnessMap=brushed;
  const geometries=new Map();
  function box(w,h,d,r=.045){const key=[w,h,d,r].join('/');if(!geometries.has(key))geometries.set(key,new RoundedBoxGeometry(w,h,d,2,r));return geometries.get(key);}
  function mesh(geometry,material,parent,position){const m=new T.Mesh(geometry,material);m.castShadow=true;m.receiveShadow=true;if(position)m.position.copy(position);parent.add(m);return m;}
  function block(parent,size,position,material=mats.graphite){return mesh(box(...size),material,parent,v(...position));}
  function octagon(r,cut){return [[-r+cut,-r],[r-cut,-r],[r,-r+cut],[r,r-cut],[r-cut,r],[-r+cut,r],[-r,r-cut],[-r,-r+cut]];}
  function ring(radius,inner,depth){
    const shape=new T.Shape();const pts=octagon(radius,.27);shape.moveTo(...pts[0]);pts.slice(1).forEach(p=>shape.lineTo(...p));shape.closePath();
    // Matching corner cuts keep very thin illuminated rings from self-intersecting.
    const hole=new T.Path();const ins=octagon(inner,.27).reverse();hole.moveTo(...ins[0]);ins.slice(1).forEach(p=>hole.lineTo(...p));hole.closePath();shape.holes.push(hole);
    const g=new T.ExtrudeGeometry(shape,{depth,bevelEnabled:true,bevelSize:.025,bevelThickness:.025,bevelSegments:2,curveSegments:1,steps:1});g.translate(0,0,-depth/2);return g;
  }
  const ground=mesh(new T.PlaneGeometry(100,100),new T.MeshLambertMaterial({color:0x101214}),scene);
  ground.rotation.x=-Math.PI/2;ground.position.y=-.035;ground.castShadow=false;
  if(kind==='hero')ground.visible=false;
  const world=new T.Group();scene.add(world);
  const objects={};const anchors={};const raycastObjects=[];
  function register(id,group,anchor){group.userData.node=id;objects[id]=group;anchors[id]=anchor;raycastObjects.push(group);}
  const vault=new T.Group();world.add(vault);
  let layers=[],doors=[],core,proofNodes=[],pathLinks=[];
  const unitSphere=new T.SphereGeometry(.025,8,6);
  function makeVault(){
    block(vault,[2.95,.18,2.35],[0,.09,0],mats.black);
    block(vault,[2.68,.065,2.1],[0,.21,0],mats.gold);
    block(vault,[2.8,.13,2.2],[0,.29,0],mats.graphite);
    for(let i=0;i<7;i++){
      const layer=new T.Group();const z=-.68+i*.23;layer.position.set(0,1.65,z);layer.userData.z=z;
      const radius=i===0||i===6?1.29:1.23;
      mesh(ring(radius,.94,i%2?.12:.17),i===6?mats.steel:i%2?mats.graphite:mats.steel,layer);
      if(i===1||i===5)mesh(ring(1.05,1.028,.035),mats.glow,layer,v(0,0,.09));
      for(const x of [-1.07,1.07])for(const y of [-.9,.9]){
        const bolt=mesh(new T.CylinderGeometry(.043,.043,.035,6),mats.black,layer,v(x,y,.11));bolt.rotation.x=Math.PI/2;
        const slot=block(layer,[.036,.009,.008],[x,y,.132],mats.steel);slot.rotation.z=Math.PI/4;
      }
      vault.add(layer);layers.push(layer);
    }
    block(vault,[1.8,1.8,.09],[0,1.65,-.81],mats.black);
    core=mesh(box(.95,.95,.95,.025),mats.glass,vault,v(-.12,1.65,.56));
    const lattice=new T.Group();lattice.position.copy(core.position);vault.add(lattice);
    const lineMaterial=new T.LineBasicMaterial({color:0xffdc69,transparent:true,opacity:.78});
    const points=[];
    for(let a=-1;a<=1;a++)for(let b=-1;b<=1;b++){
      points.push(v(-.47,a*.47,b*.47),v(.47,a*.47,b*.47));
      points.push(v(a*.47,-.47,b*.47),v(a*.47,.47,b*.47));
      points.push(v(a*.47,b*.47,-.47),v(a*.47,b*.47,.47));
    }
    lattice.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(points),lineMaterial));
    const dots=new T.InstancedMesh(unitSphere,mats.glow,27);let j=0;const dummy=new T.Object3D();
    for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++){dummy.position.set(x*.47,y*.47,z*.47);dummy.updateMatrix();dots.setMatrixAt(j++,dummy.matrix);}lattice.add(dots);
    for(const side of [-1,1]){
      const door=new T.Group();door.userData.side=side;door.position.set(side*.46,1.65,.93);
      block(door,[.84,1.78,.12],[0,0,0],mats.graphite);
      block(door,[.065,1.6,.05],[side*-.35,0,.085],mats.steel);
      block(door,[.62,.07,.05],[0,.38,.085],mats.steel);
      block(door,[.62,.07,.05],[0,-.38,.085],mats.steel);
      vault.add(door);doors.push(door);
    }
    const halo=new T.PointLight(0xffbc20,2.5,4,2);halo.position.set(0,1.3,.6);vault.add(halo);
    register('account',vault,v(0,3.05,.1));
  }
  const routes={},particles={},routeViews={};
  let relatedNode='account';
  function curveTube(points,radius,material,parent=world){const curve=new T.CatmullRomCurve3(points.map(p=>v(...p)));mesh(new T.TubeGeometry(curve,48,radius,6,false),material,parent).castShadow=false;return curve;}
  function addFlowLink(id,points){
    const link=FLOW_LINKS.find(item=>item.id===id);
    const curve=new T.CatmullRomCurve3(points.map(p=>v(...p)));routes[id]=curve;
    const color=link.kind==='asset'?0xf0b90b:link.kind==='gas'?0xb58b50:link.kind==='receipt'?0xacc2cc:0xd9e5e8;
    let line;
    if(link.kind==='asset'||link.kind==='gas'){
      const material=(link.kind==='asset'?mats.gold:mats.fee).clone();material.emissive.setHex(color);
      line=mesh(new T.TubeGeometry(curve,48,link.kind==='asset'?.035:.017,6,false),material,world);line.castShadow=false;
    }else{
      line=new T.Line(new T.BufferGeometry().setFromPoints(curve.getPoints(80)),new T.LineDashedMaterial({color,dashSize:link.kind==='receipt'?.055:.11,gapSize:.055,transparent:true,opacity:.7}));
      line.computeLineDistances();world.add(line);
    }
    const arrow=new T.ArrowHelper(curve.getTangent(.76).normalize(),curve.getPoint(.76),.22,color,.12,.085);
    arrow.line.visible=false;arrow.cone.material.transparent=true;world.add(arrow);
    const sockets=[0,1].map(t=>mesh(new T.SphereGeometry(.035,8,6),new T.MeshBasicMaterial({color,transparent:true}),world,curve.getPoint(t)));
    routeViews[id]={link,line,arrow,sockets,color};
  }
  function tray(id,x,z,r=.65){const group=new T.Group();group.position.set(x,0,z);world.add(group);
    mesh(new T.CylinderGeometry(r,r+.06,.16,48),mats.black,group,v(0,.08,0));
    mesh(new T.CylinderGeometry(r*.83,r*.83,.04,48),mats.graphite,group,v(0,.18,0));
    const rim=mesh(new T.TorusGeometry(r-.045,.045,8,56),mats.steel,group,v(0,.22,0));rim.rotation.x=Math.PI/2;
    const band=mesh(new T.TorusGeometry(r+.01,.014,6,48),mats.glow,group,v(0,.08,0));band.rotation.x=Math.PI/2;
    register(id,group,v(x,.65,z));return group;
  }
  function makeFlow(){
    const signer=new T.Group();signer.position.set(-3.5,0,-.65);world.add(signer);
    block(signer,[1.22,.16,.98],[0,.08,0],mats.black);block(signer,[1.08,.3,.85],[0,.26,0],mats.steel);
    const face=block(signer,[.87,.035,.61],[0,.43,0],mats.black);face.rotation.x=.12;
    curveTube([[-.26,.49,0],[-.12,.54,-.07],[0,.49,.1],[.16,.53,-.02],[.28,.51,.04]],.012,mats.glow,signer);
    register('signer',signer,v(-3.5,.85,-.65));
    tray('recipient',3.55,-.2,.75);tray('payer',-3.3,2.1,.43);
    const gasCore=block(objects.payer,[.28,.3,.28],[0,.32,0],mats.glass);
    const net=new T.Group();net.position.set(.1,0,2.45);world.add(net);
    block(net,[1.1,.26,.65],[0,.13,0],mats.steel);block(net,[.86,.03,.44],[0,.28,0],mats.black);
    for(let i=0;i<4;i++)block(net,[.11,.035,.25],[-.27+i*.18,.31,0],mats.gold);
    register('network',net,v(.1,.62,2.45));
    addFlowLink('asset',[[.08,.65,1.1],[1.05,.43,1.4],[2.5,.28,.55],[3.55,.28,-.2]]);
    curveTube([[.08,.55,1.1],[1.05,.33,1.4],[2.5,.18,.55],[3.55,.18,-.2]],.065,mats.graphite);
    // Signed payload -> submitting EOA -> network -> smart-account execution.
    // Gas and the receipt occupy their own lanes between EOA and network.
    addFlowLink('authorization',[[-3.65,.55,-.35],[-3.8,.72,.4],[-3.8,.6,1.45],[-3.3,.42,2.1]]);
    addFlowLink('submission',[[-3.15,.42,2.1],[-2.2,.65,1.9],[-.7,.6,2.12],[.0,.32,2.35]]);
    addFlowLink('gas',[[-3.3,.16,2.1],[-2.1,.13,2.35],[-.6,.13,2.45],[.1,.17,2.45]]);
    addFlowLink('invoke',[[-.2,.32,2.3],[-.75,.5,2.05],[-1.55,.65,1.6],[-1.12,.65,1.1]]);
    addFlowLink('receipt',[[.15,.32,2.7],[-.8,.25,3.05],[-2.7,.25,3.0],[-3.3,.28,2.4]]);
    for(const link of FLOW_LINKS){
      const type=link.id,count=link.kind==='asset'?6:link.kind==='gas'?3:4;
      const signal=link.kind==='proof'||link.kind==='receipt';
      const material=link.kind==='asset'?mats.glow:link.kind==='gas'?mats.fee:link.kind==='receipt'?mats.receipt:mats.proof;
      particles[type]=[];
      for(let i=0;i<count;i++){const p=mesh(signal?new T.SphereGeometry(.042,8,6):box(type==='asset'?.15:.06,type==='asset'?.17:.06,type==='asset'?.15:.06,.018),material,world);p.visible=false;particles[type].push(p);}
    }
    particles.received=[];
    for(let i=0;i<6;i++){const p=block(objects.recipient,[.16,.17,.16],[(i%3-1)*.2,.32,Math.floor(i/3)*.22-.11],mats.glass);p.visible=false;particles.received.push(p);}
    // Fine architectural floor seams, not an infinite animated grid.
    for(let x=-7;x<=7;x+=1.7)curveTube([[x,-.02,-6],[x,-.02,7]],.003,mats.graphite);
  }
  function makeProof(){
    vault.visible=false;raycastObjects.length=0;const group=new T.Group();world.add(group);
    block(group,[2.8,.16,2.0],[0,.08,0],mats.graphite);block(group,[2.4,.04,1.6],[0,.19,0],mats.gold);
    for(let i=0;i<=10;i++){
      const node=new T.Group();node.position.set((i%2-.5)*.28,.45+i*.25,0);node.userData.baseY=node.position.y;node.userData.node=String(i);
      const base=block(node,[i===10?1:.68,.12,i===10?1:.68],[0,0,0],mats.steel);
      block(node,[i===10?.8:.51,.035,i===10?.8:.51],[0,.08,0],mats.gold);
      node.userData.base=base;group.add(node);proofNodes.push(node);raycastObjects.push(node);
      if(i<10){const link=mesh(new T.CylinderGeometry(.013,.013,.3,8),mats.glow,group,v(0,.6+i*.25,0));pathLinks.push(link);}
    }
    const cage=mesh(ring(1.72,1.66,.04),mats.steel,group,v(0,1.75,-.6));cage.rotation.z=.1;
  }
  makeVault();if(kind==='flow')makeFlow();if(kind==='proof')makeProof();
  let raf=0,last=0,disposed=false,inView=true,contextLost=false;
  let explosion=kind==='hero'?.62:0,explosionTarget=explosion;
  let gate=kind==='hero'?.7:0,gateTarget=gate,flowState;
  let autoRotate=false,orbitDirection=1,proofLevel=10,proofValid=null,zoom=1;
  let cameraTween=null,basePosition,baseTarget,baseRadius;
  function homeCamera(){
    const aspect=canvas.clientWidth/Math.max(1,canvas.clientHeight);
    baseTarget=kind==='flow'?v(0,canvas.clientWidth<600?2.25:1.5,.3):kind==='proof'?v(0,1.95,0):v(0,1.58,0);
    const direction=kind==='flow'?v(4.9,3.6,8.8).normalize():v(4.7,2.65,7.3).normalize();
    const span=kind==='flow'?(canvas.clientWidth<600?10.6:9.9):kind==='proof'?4.1:5.8;
    baseRadius=Math.max(kind==='flow'?12.2:kind==='proof'?8.4:6.5,span/(2*Math.tan(T.MathUtils.degToRad(35/2))*aspect));
    basePosition=baseTarget.clone().addScaledVector(direction,baseRadius);
    camera.position.copy(basePosition);controls.target.copy(baseTarget);camera.zoom=zoom;camera.updateProjectionMatrix();
    controls.minDistance=baseRadius*.66;controls.maxDistance=baseRadius*1.5;controls.update();
  }
  function resize(){const w=canvas.clientWidth,h=canvas.clientHeight;if(!w||!h)return;renderer.setSize(w,h,false);camera.aspect=w/h;homeCamera();request();}
  function request(){if(!raf&&!disposed&&inView&&!document.hidden&&!contextLost)raf=requestAnimationFrame(render);}
  function moveParticles(type,phase){
    particles[type]?.forEach((p,i)=>{const t=phase-i*.075;p.visible=phase>0&&t>=0&&t<1;if(p.visible){p.position.copy(routes[type].getPoint(clamp(t,0,1)));if(type==='asset')p.rotation.y=-t;}});
  }
  const projection=new T.Vector3();
  function render(time){
    raf=0;if(disposed||document.hidden||!inView||contextLost)return;
    const dt=last?Math.min(time-last,40):16;last=time;
    const rate=reduceMotion.matches?1:Math.min(1,dt/135);
    explosion=T.MathUtils.lerp(explosion,explosionTarget,rate);gate=T.MathUtils.lerp(gate,gateTarget,rate);
    layers.forEach((layer,i)=>{layer.position.z=layer.userData.z+(i-2.5)*explosion*.3;});
    doors.forEach(door=>{door.position.x=door.userData.side*(.46+gate*.92+explosion*.38);door.position.z=.93+explosion*.85;});
    if(kind==='flow'&&flowState){
      const phase={authorization:flowState.authorizationPhase,submission:flowState.submissionPhase,invoke:flowState.invokePhase,
        asset:flowState.rejected||flowState.transferred?0:flowState.transferPhase*1.35,gas:flowState.gasPhase*1.3,receipt:flowState.receiptPhase};
      for(const [id,value] of Object.entries(phase))moveParticles(id,value);
      for(const [id,view] of Object.entries(routeViews)){
        const related=view.link.from===relatedNode||view.link.to===relatedNode;
        const active=(phase[id]>0&&phase[id]<1.5)||(id==='gas'&&flowState.feePaid)||(id==='receipt'&&flowState.receiptReady);
        const failure=id==='invoke'&&flowState.rejected;
        const color=failure?0xec8874:view.color;
        view.line.material.color.setHex(color);
        if(view.line.material.emissive)view.line.material.emissiveIntensity=active?.38:related?.20:.035;
        else view.line.material.opacity=active?.95:related?.85:.42;
        view.arrow.setColor(color);view.arrow.cone.material.opacity=active||related?1:.55;
        view.sockets.forEach(socket=>{socket.material.opacity=active||related?1:.55;socket.material.color.setHex(color);});
      }
      particles.received.forEach(p=>p.visible=flowState.transferred);
      layers[5].children[1].material=flowState.rejected?mats.failure:mats.glow;
    }
    if(kind==='proof'){
      proofNodes.forEach((node,i)=>{node.position.y=node.userData.baseY+i*explosion*.12;node.position.x=(i%2-.5)*(.28+explosion*.65);node.userData.base.material=i===proofLevel?(proofValid===false?mats.failure:mats.glow):i<proofLevel?mats.steel:mats.graphite;});
      pathLinks.forEach((link,i)=>{link.position.y=.6+i*.25+(i+.5)*explosion*.12;link.scale.y=1+explosion*.4;});
    }
    if(cameraTween){
      const amount=reduceMotion.matches?1:Math.min(1,dt/110);camera.position.lerp(cameraTween.position,amount);controls.target.lerp(cameraTween.target,amount);
      if(camera.position.distanceTo(cameraTween.position)<.006&&controls.target.distanceTo(cameraTween.target)<.006)cameraTween=null;
    }
    if(autoRotate&&!reduceMotion.matches){const relative=camera.position.clone().sub(controls.target);const theta=Math.atan2(relative.x,relative.z);if(theta>1.2)orbitDirection=-1;if(theta<-.8)orbitDirection=1;relative.applyAxisAngle(v(0,1,0),dt*.00013*orbitDirection);camera.position.copy(controls.target).add(relative);}
    controls.update();renderer.render(scene,camera);
    if(kind==='flow')for(const [id,point] of Object.entries(anchors)){
      projection.copy(point).project(camera);const el=host.querySelector('[data-flow-node="'+id+'"]');if(!el)continue;
      const edge=el.offsetWidth/2+12;
      el.style.left=clamp((projection.x*.5+.5)*canvas.clientWidth,edge,canvas.clientWidth-edge)+'px';
      el.style.top=clamp((-.5*projection.y+.5)*canvas.clientHeight,canvas.clientWidth<600?220:190,canvas.clientHeight-90)+'px';
    }
    if(Math.abs(explosion-explosionTarget)>.002||Math.abs(gate-gateTarget)>.002||cameraTween||autoRotate)request();
  }
  controls.addEventListener('change',request);
  controls.addEventListener('start',()=>{cameraTween=null;});
  let down=null;
  canvas.addEventListener('pointerdown',e=>{down={x:e.clientX,y:e.clientY};});
  canvas.addEventListener('pointerup',e=>{
    if(!down||Math.hypot(e.clientX-down.x,e.clientY-down.y)>6){down=null;return;}down=null;
    const r=canvas.getBoundingClientRect();const ray=new T.Raycaster();ray.setFromCamera(new T.Vector2((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1),camera);
    const hit=ray.intersectObjects(raycastObjects,true)[0];let obj=hit?.object;while(obj&&obj.userData.node===undefined)obj=obj.parent;if(obj)onSelect(obj.userData.node);
  });
  canvas.addEventListener('pointercancel',()=>{down=null;});
  canvas.addEventListener('keydown',e=>{
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','-','Home'].includes(e.key))return;e.preventDefault();
    if(e.key==='Home'){api.reset();return;}
    if(e.key==='+'||e.key==='-'){api.zoomBy(e.key==='+'?1.1:.9);return;}
    const relative=camera.position.clone().sub(controls.target);const spherical=new T.Spherical().setFromVector3(relative);
    spherical.theta=clamp(spherical.theta+(e.key==='ArrowLeft'?-.12:e.key==='ArrowRight'?.12:0),-.85,1.25);
    spherical.phi=clamp(spherical.phi+(e.key==='ArrowUp'?-.08:e.key==='ArrowDown'?.08:0),.55,1.45);
    camera.position.copy(controls.target).add(new T.Vector3().setFromSpherical(spherical));controls.update();request();
  });
  const observer=new ResizeObserver(resize);observer.observe(canvas);
  const intersection=new IntersectionObserver(entries=>{inView=entries[0].isIntersecting;if(inView){last=0;request();}else{cancelAnimationFrame(raf);raf=0;}});intersection.observe(canvas);
  function visibility(){if(document.hidden){cancelAnimationFrame(raf);raf=0;autoRotate=false;onAutoStop();}else{last=0;request();}}
  document.addEventListener('visibilitychange',visibility);
  canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();contextLost=true;cancelAnimationFrame(raf);raf=0;host.dataset.unavailable='true';delete host.dataset.ready;});
  canvas.addEventListener('webglcontextrestored',()=>{contextLost=false;delete host.dataset.unavailable;host.dataset.ready='true';request();});
  function motionChange(){if(reduceMotion.matches){autoRotate=false;onAutoStop();}request();}reduceMotion.addEventListener('change',motionChange);
  const api={
    request,
    explode(value){explosionTarget=value?kind==='hero'?.85:1:0;if(kind==='hero')gateTarget=value?.7:0;request();},
    setFlow(state){flowState=state;gateTarget=state.gateOpen?1:0;request();},
    selectConnections(id){relatedNode=id;request();},
    setProof(level,valid=null){proofLevel=level;proofValid=valid;request();},
    autoRotate(value){autoRotate=value&&!reduceMotion.matches;request();return autoRotate;},
    zoomBy(factor){zoom=clamp(zoom*factor,.7,1.4);camera.zoom=zoom;camera.updateProjectionMatrix();request();},
    setZoom(value){zoom=clamp(value,.7,1.4);camera.zoom=zoom;camera.updateProjectionMatrix();request();},
    reset(){cameraTween=null;zoom=1;homeCamera();request();},
    focus(id){const point=anchors[id];if(!point)return;const target=baseTarget.clone().lerp(point,.18);target.y=baseTarget.y;cameraTween={target,position:basePosition.clone().add(target.clone().sub(baseTarget)).lerp(target,.02)};request();},
    dispose(){if(disposed)return;disposed=true;cancelAnimationFrame(raf);observer.disconnect();intersection.disconnect();controls.dispose();document.removeEventListener('visibilitychange',visibility);reduceMotion.removeEventListener('change',motionChange);const gs=new Set(),ms=new Set();scene.traverse(o=>{if(o.geometry)gs.add(o.geometry);if(o.material)(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>ms.add(m));});gs.forEach(g=>g.dispose());ms.forEach(m=>m.dispose());brushed.dispose();environment.dispose();renderer.dispose();}
  };
  window.addEventListener('pagehide',event=>{if(!event.persisted)api.dispose();});
  host.dataset.ready='true';resize();return api;
}
