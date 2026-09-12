
require("dotenv").config();
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const Stripe = require("stripe");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_ME_IN_RENDER";
const recipes = Array.from({length:10}, (_,i) => JSON.parse(fs.readFileSync(path.join(__dirname,"data",`recipes-${String(i+1).padStart(2,"0")}.json`),"utf8"))).flat();

/* -------------------- DATABASE -------------------- */
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

const localUsers = new Map();
const localUsage = new Map();
const localFavorites = new Map();
const localProfiles = new Map();
const localHistory = new Map();

async function dbInit(){
  if(!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users(
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      premium BOOLEAN NOT NULL DEFAULT FALSE,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      plan TEXT,
      subscription_status TEXT,
      subscription_ends_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS usage(
      user_id TEXT NOT NULL,
      usage_date DATE NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id, usage_date)
    );
    CREATE TABLE IF NOT EXISTS profiles(
      user_id TEXT PRIMARY KEY,
      name TEXT DEFAULT '',
      goal TEXT DEFAULT 'equilibrar',
      level TEXT DEFAULT 'iniciante',
      weekly_days INTEGER DEFAULT 3,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS favorites(
      user_id TEXT NOT NULL,
      recipe_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY(user_id, recipe_id)
    );
    CREATE TABLE IF NOT EXISTS analyses(
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      result JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS shopping(
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      item TEXT NOT NULL,
      checked BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

function rid(){ return Math.random().toString(36).slice(2)+Date.now().toString(36); }
function today(){ return new Date().toISOString().slice(0,10); }
function freeLimit(){ return 5; }

async function getUserByEmail(email){
  if(pool){ const r=await pool.query("SELECT * FROM users WHERE email=$1",[email]); return r.rows[0]||null; }
  return [...localUsers.values()].find(u=>u.email===email)||null;
}
async function getUserById(id){
  if(pool){ const r=await pool.query("SELECT * FROM users WHERE id=$1",[id]); return r.rows[0]||null; }
  return localUsers.get(id)||null;
}
async function createUser(u){
  if(pool){
    await pool.query("INSERT INTO users(id,email,password_hash,premium) VALUES($1,$2,$3,false)",[u.id,u.email,u.password_hash]);
    await pool.query("INSERT INTO profiles(user_id) VALUES($1) ON CONFLICT DO NOTHING",[u.id]);
  }else{ localUsers.set(u.id,u); localProfiles.set(u.id,{user_id:u.id,name:"",goal:"equilibrar",level:"iniciante",weekly_days:3}); }
}
async function setUserPremium(id,data){
  if(pool){
    await pool.query(`UPDATE users SET premium=$2, stripe_customer_id=COALESCE($3,stripe_customer_id),
      stripe_subscription_id=$4, plan=$5, subscription_status=$6, subscription_ends_at=$7 WHERE id=$1`,
      [id,!!data.premium,data.customerId||null,data.subscriptionId||null,data.plan||null,data.status||null,data.endsAt||null]);
  }else{
    const u=localUsers.get(id); if(u){Object.assign(u,{premium:!!data.premium,stripe_customer_id:data.customerId||u.stripe_customer_id,stripe_subscription_id:data.subscriptionId||null,plan:data.plan||null,subscription_status:data.status||null,subscription_ends_at:data.endsAt||null});}
  }
}
async function usageCount(id){
  if(pool){ const r=await pool.query("SELECT count FROM usage WHERE user_id=$1 AND usage_date=$2",[id,today()]); return Number(r.rows[0]?.count||0); }
  return Number(localUsage.get(id+":"+today())||0);
}
async function bumpUsage(id){
  if(pool){
    await pool.query(`INSERT INTO usage(user_id,usage_date,count) VALUES($1,$2,1)
      ON CONFLICT(user_id,usage_date) DO UPDATE SET count=usage.count+1`,[id,today()]);
  }else{ const k=id+":"+today(); localUsage.set(k,(localUsage.get(k)||0)+1); }
}
function sign(u){ return jwt.sign({id:u.id,email:u.email,premium:!!u.premium},JWT_SECRET,{expiresIn:"30d"}); }
async function auth(req,res,next){
  try{
    const p=jwt.verify((req.headers.authorization||"").replace("Bearer ",""),JWT_SECRET);
    const u=await getUserById(p.id);
    if(!u) throw Error();
    req.user=u; next();
  }catch(e){ return res.status(401).json({error:"Não autenticado"}); }
}
async function enforceFree(req,res){
  if(req.user.premium) return false;
  const used=await usageCount(req.user.id);
  if(used>=freeLimit()){ res.status(429).json({error:"Você atingiu o limite gratuito de 5 usos por dia. Assine o Premium para continuar."}); return true; }
  return false;
}

/* Stripe webhook must receive raw body BEFORE express.json. */
app.post("/api/stripe/webhook", express.raw({type:"application/json"}), async(req,res)=>{
  if(!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send("Stripe não configurado");
  try{
    const stripe=new Stripe(process.env.STRIPE_SECRET_KEY);
    const event=stripe.webhooks.constructEvent(req.body,req.headers["stripe-signature"],process.env.STRIPE_WEBHOOK_SECRET);
    const obj=event.data.object;
    if(event.type==="checkout.session.completed"){
      const uid=obj.metadata?.userId;
      if(uid && obj.subscription){
        const sub=await stripe.subscriptions.retrieve(obj.subscription);
        const item=sub.items.data[0];
        await setUserPremium(uid,{premium:true,customerId:String(obj.customer||""),subscriptionId:String(sub.id),plan:obj.metadata?.plan,status:sub.status,endsAt:item?.current_period_end?new Date(item.current_period_end*1000):null});
      }
    }
    if(event.type==="customer.subscription.updated" || event.type==="customer.subscription.created"){
      const sub=obj, uid=sub.metadata?.userId;
      if(uid){
        const active=["active","trialing","past_due"].includes(sub.status);
        const item=sub.items.data[0];
        await setUserPremium(uid,{premium:active,customerId:String(sub.customer||""),subscriptionId:String(sub.id),plan:sub.metadata?.plan,status:sub.status,endsAt:item?.current_period_end?new Date(item.current_period_end*1000):null});
      }
    }
    if(event.type==="customer.subscription.deleted"){
      const sub=obj, uid=sub.metadata?.userId;
      if(uid) await setUserPremium(uid,{premium:false,customerId:String(sub.customer||""),subscriptionId:null,plan:null,status:"canceled",endsAt:null});
    }
    res.json({received:true});
  }catch(e){ console.error(e); res.status(400).send("Webhook inválido"); }
});

app.use(express.json({limit:"12mb"}));
app.use(express.static(path.join(__dirname,"public")));

app.get("/api/health",async(req,res)=>res.json({ok:true,app:"Mini Cook",recipes:recipes.length,database:!!pool}));
app.get("/api/recipes/count",(req,res)=>res.json({count:recipes.length}));

app.get("/api/recipes", (req,res)=>{
  const q=String(req.query.q||"").trim().toLowerCase(), cat=String(req.query.category||"").trim().toLowerCase();
  const cuisine=String(req.query.cuisine||"").trim().toLowerCase();
  const diet=String(req.query.diet||"").trim().toLowerCase();
  const difficulty=String(req.query.difficulty||"").trim().toLowerCase();
  const max=Number(req.query.max||99999);
  let list=recipes;
  if(q) list=list.filter(r=>(r.name+" "+r.tags.join(" ")+" "+r.ingredients.join(" ")+" "+r.cuisine).toLowerCase().includes(q));
  if(cat) list=list.filter(r=>r.category.toLowerCase().includes(cat));
  if(cuisine) list=list.filter(r=>r.cuisine.toLowerCase().includes(cuisine));
  if(diet) list=list.filter(r=>r.diet.toLowerCase().includes(diet));
  if(difficulty) list=list.filter(r=>r.difficulty.toLowerCase()===difficulty);
  list=list.filter(r=>r.calories<=max);
  const page=Math.max(1,Number(req.query.page||1)), size=Math.min(60,Math.max(1,Number(req.query.size||24)));
  const start=(page-1)*size;
  res.json({total:list.length,page,size,items:list.slice(start,start+size)});
});
app.get("/api/recipes/:id",(req,res)=>{
  const r=recipes.find(x=>x.id===Number(req.params.id));
  r?res.json(r):res.status(404).json({error:"Receita não encontrada"});
});

app.post("/api/auth/signup",async(req,res)=>{
  const email=String(req.body.email||"").trim().toLowerCase(), password=String(req.body.password||"");
  if(!email||password.length<6) return res.status(400).json({error:"Informe e-mail e senha de pelo menos 6 caracteres."});
  if(await getUserByEmail(email)) return res.status(409).json({error:"Esse e-mail já está cadastrado."});
  const u={id:rid(),email,password_hash:await bcrypt.hash(password,10),premium:false};
  await createUser(u); res.json({token:sign(u),user:{email,premium:false}});
});
app.post("/api/auth/login",async(req,res)=>{
  const email=String(req.body.email||"").trim().toLowerCase(), password=String(req.body.password||"");
  const u=await getUserByEmail(email);
  if(!u || !(await bcrypt.compare(password,u.password_hash))) return res.status(401).json({error:"E-mail ou senha inválidos."});
  res.json({token:sign(u),user:{email,premium:!!u.premium}});
});
app.get("/api/me",auth,async(req,res)=>{
  const u=await getUserById(req.user.id);
  res.json({email:u.email,premium:!!u.premium,plan:u.plan||null,status:u.subscription_status||null,endsAt:u.subscription_ends_at||null});
});
app.get("/api/usage",auth,async(req,res)=>res.json({used:await usageCount(req.user.id),limit:req.user.premium?null:freeLimit(),premium:!!req.user.premium}));

/* Profile, favorites, history, shopping */
app.get("/api/profile",auth,async(req,res)=>{
  if(pool){const r=await pool.query("SELECT * FROM profiles WHERE user_id=$1",[req.user.id]);return res.json(r.rows[0]||{});}
  res.json(localProfiles.get(req.user.id)||{});
});
app.put("/api/profile",auth,async(req,res)=>{
  const p={name:String(req.body.name||"").slice(0,80),goal:String(req.body.goal||"equilibrar").slice(0,40),level:String(req.body.level||"iniciante").slice(0,30),weekly_days:Math.min(7,Math.max(1,Number(req.body.weekly_days||3)))};
  if(pool){await pool.query(`INSERT INTO profiles(user_id,name,goal,level,weekly_days) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(user_id) DO UPDATE SET name=$2,goal=$3,level=$4,weekly_days=$5`,[req.user.id,p.name,p.goal,p.level,p.weekly_days]);}
  else localProfiles.set(req.user.id,{user_id:req.user.id,...p});
  res.json(p);
});
app.get("/api/favorites",auth,async(req,res)=>{
  if(pool){const r=await pool.query("SELECT recipe_id FROM favorites WHERE user_id=$1 ORDER BY created_at DESC",[req.user.id]);return res.json(r.rows.map(x=>Number(x.recipe_id)));}
  res.json([...(localFavorites.get(req.user.id)||[])]);
});
app.post("/api/favorites/:id",auth,async(req,res)=>{
  const id=Number(req.params.id);
  if(pool) await pool.query("INSERT INTO favorites(user_id,recipe_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[req.user.id,id]);
  else {const a=localFavorites.get(req.user.id)||[];if(!a.includes(id))a.push(id);localFavorites.set(req.user.id,a);}
  res.json({ok:true});
});
app.delete("/api/favorites/:id",auth,async(req,res)=>{
  const id=Number(req.params.id);
  if(pool) await pool.query("DELETE FROM favorites WHERE user_id=$1 AND recipe_id=$2",[req.user.id,id]);
  else {const a=(localFavorites.get(req.user.id)||[]).filter(x=>x!==id);localFavorites.set(req.user.id,a);}
  res.json({ok:true});
});
app.get("/api/shopping",auth,async(req,res)=>{
  if(pool){const r=await pool.query("SELECT id,item,checked FROM shopping WHERE user_id=$1 ORDER BY created_at DESC",[req.user.id]);return res.json(r.rows);}
  res.json([]);
});
app.post("/api/shopping",auth,async(req,res)=>{
  const item=String(req.body.item||"").trim().slice(0,120); if(!item)return res.status(400).json({error:"Item vazio"});
  if(pool){const r=await pool.query("INSERT INTO shopping(user_id,item) VALUES($1,$2) RETURNING id,item,checked",[req.user.id,item]);return res.json(r.rows[0]);}
  res.json({id:Date.now(),item,checked:false});
});
app.delete("/api/shopping/:id",auth,async(req,res)=>{if(pool)await pool.query("DELETE FROM shopping WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);res.json({ok:true});});

/* Access code */
app.post("/api/redeem",auth,async(req,res)=>{
  const code=String(req.body.code||"").trim();
  const configured=String(process.env.PREMIUM_CODE||"").trim();
  if(!configured) return res.status(503).json({error:"O sistema de códigos ainda não foi configurado."});
  if(!code || code!==configured) return res.status(400).json({error:"Código inválido."});
  await setUserPremium(req.user.id,{premium:true,plan:"Código de acesso",status:"active",endsAt:null});
  res.json({ok:true,message:"Código ativado. Seu Premium foi liberado."});
});

/* AI */
async function openrouter(body){
  if(!process.env.OPENROUTER_API_KEY) throw Object.assign(new Error("IA não configurada no servidor."),{status:503});
  const rr=await fetch("https://openrouter.ai/api/v1/chat/completions",{
    method:"POST",
    headers:{"Authorization":"Bearer "+process.env.OPENROUTER_API_KEY,"Content-Type":"application/json","HTTP-Referer":process.env.APP_URL||"http://localhost:3000","X-Title":"Mini Cook"},
    body:JSON.stringify(body)
  });
  const d=await rr.json(); if(!rr.ok) throw Object.assign(new Error(d?.error?.message||"Falha no provedor de IA."),{status:502}); return d;
}
app.post("/api/chat",auth,async(req,res)=>{
  if(await enforceFree(req,res))return;
  const message=String(req.body.message||"").trim(), history=Array.isArray(req.body.history)?req.body.history.slice(-8):[];
  if(!message)return res.status(400).json({error:"Mensagem vazia."});
  try{
    const d=await openrouter({model:process.env.OPENROUTER_MODEL||"openrouter/free",temperature:.65,messages:[
      {role:"system",content:"Você é o Mini Cook: assistente de alimentação, culinária e dicas gerais de treino. Seja prático, acolhedor e claro. Não diagnostique doenças nem substitua profissionais. Calorias e macros devem ser tratados como estimativas."},
      ...history,{role:"user",content:message}
    ]});
    await bumpUsage(req.user.id); res.json({reply:d?.choices?.[0]?.message?.content||"Não consegui responder agora."});
  }catch(e){res.status(e.status||500).json({error:e.message||"Erro na IA."});}
});
app.post("/api/analyze-food",auth,async(req,res)=>{
  if(await enforceFree(req,res))return;
  const image=String(req.body.image||""); if(!image.startsWith("data:image/"))return res.status(400).json({error:"Imagem inválida."});
  try{
    const model=process.env.OPENROUTER_VISION_MODEL||process.env.OPENROUTER_MODEL||"openrouter/free";
    const d=await openrouter({model,temperature:.2,messages:[
      {role:"system",content:"Você é o Mini Cook Vision. Analise alimentos visualmente. Sempre trate calorias e macros como ESTIMATIVAS, informe incerteza e nunca apresente diagnóstico. Retorne JSON puro."},
      {role:"user",content:[
        {type:"text",text:"Analise esta foto e retorne JSON com dish, detected_items, estimated_portion, calories_min, calories_max, protein_g, carbs_g, fat_g, confidence, tips, healthier_swaps, recipe_ideas."},
        {type:"image_url",image_url:{url:image}}
      ]}
    ]});
    let txt=(d?.choices?.[0]?.message?.content||"").replace(/```json|```/g,"").trim(), result;
    try{result=JSON.parse(txt)}catch{result={dish:"Análise recebida",raw:txt}};
    await bumpUsage(req.user.id);
    if(pool) await pool.query("INSERT INTO analyses(user_id,result) VALUES($1,$2)",[req.user.id,JSON.stringify(result)]);
    res.json(result);
  }catch(e){res.status(e.status||500).json({error:e.message||"Falha na análise."});}
});
app.get("/api/analyses",auth,async(req,res)=>{
  if(!pool)return res.json([]);
  const r=await pool.query("SELECT id,result,created_at FROM analyses WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30",[req.user.id]);
  res.json(r.rows);
});

/* Stripe subscriptions */
const PLAN_ENV={
  monthly:"STRIPE_PRICE_MONTHLY",
  quarterly:"STRIPE_PRICE_QUARTERLY",
  yearly:"STRIPE_PRICE_YEARLY"
};
app.post("/api/create-checkout",auth,async(req,res)=>{
  const plan=String(req.body.plan||""); const envKey=PLAN_ENV[plan];
  if(!envKey || !process.env[envKey]) return res.status(503).json({error:"O preço deste plano ainda não foi configurado no Stripe."});
  if(!process.env.STRIPE_SECRET_KEY)return res.status(503).json({error:"Stripe ainda não configurado."});
  try{
    const stripe=new Stripe(process.env.STRIPE_SECRET_KEY);
    const session=await stripe.checkout.sessions.create({
      mode:"subscription",
      line_items:[{price:process.env[envKey],quantity:1}],
      client_reference_id:req.user.id,
      customer_email:req.user.email,
      metadata:{userId:req.user.id,plan},
      subscription_data:{metadata:{userId:req.user.id,plan}},
      success_url:(process.env.APP_URL||"http://localhost:3000")+"?payment=success",
      cancel_url:(process.env.APP_URL||"http://localhost:3000")+"?payment=cancel"
    });
    res.json({url:session.url});
  }catch(e){res.status(500).json({error:e.message||"Não foi possível iniciar o pagamento."});}
});
app.post("/api/customer-portal",auth,async(req,res)=>{
  if(!process.env.STRIPE_SECRET_KEY)return res.status(503).json({error:"Stripe não configurado."});
  const u=await getUserById(req.user.id); if(!u.stripe_customer_id)return res.status(400).json({error:"Nenhuma assinatura encontrada."});
  try{
    const stripe=new Stripe(process.env.STRIPE_SECRET_KEY);
    const s=await stripe.billingPortal.sessions.create({customer:u.stripe_customer_id,return_url:process.env.APP_URL||"http://localhost:3000"});
    res.json({url:s.url});
  }catch(e){res.status(500).json({error:e.message||"Erro no portal."});}
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

dbInit().then(()=>app.listen(PORT,"0.0.0.0",()=>console.log("Mini Cook PRO online na porta "+PORT)))
.catch(e=>{console.error("DB init failed",e);process.exit(1)});
