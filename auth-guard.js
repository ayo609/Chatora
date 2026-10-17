/* Chatora: shared Firebase setup + page guard.
   Usage on every protected page (chat.html, profile.html, onboarding.html ...):

   <html lang="en" class="guarding">
   <style>html.guarding body{visibility:hidden}</style>
   ...
   <script type="module">
     import {guard, auth, db, logout} from './auth-guard.js';
     const user = await guard();          // resolves only for a signed-in, email-verified user
     // ...your page code here
   </script>
*/
import {initializeApp} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {getAuth,onAuthStateChanged,signOut} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {getFirestore,doc,getDoc} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const firebaseConfig={
  apiKey:"AIzaSyDLVQaV9gmlNFDkQLtTytl71F_aJk15xXg",
  authDomain:"chatora-c309f.firebaseapp.com",
  projectId:"chatora-c309f",
  storageBucket:"chatora-c309f.firebasestorage.app",
  messagingSenderId:"619677340839",
  appId:"1:619677340839:web:795c3fd79d87c8d05db782"
};

export const app=initializeApp(firebaseConfig);
export const auth=getAuth(app);
export const db=getFirestore(app);

/* Page names in one place. Rename here if you change a file name. */
export const PAGES={login:'login.html',signup:'signup.html',verify:'verify-email.html',onboarding:'onboarding.html',app:'chat.html'};
/* Set to true once onboarding.html exists. Then every guarded page also requires a finished profile setup. */
const REQUIRE_ONBOARDING=false;

export const go=k=>location.replace(PAGES[k]||k);
export async function logout(to='login'){try{await signOut(auth)}finally{go(to)}}

export function guard({verified=true,onboarded=REQUIRE_ONBOARDING}={}){
  return new Promise(resolve=>{
    let open=false;
    onAuthStateChanged(auth,async u=>{
      if(open){if(!u)go('login');return}                 /* signed out in another tab */
      if(!u)return go('login');
      try{await u.reload()}                                /* refresh emailVerified from the server */
      catch(e){if(['auth/user-token-expired','auth/user-disabled','auth/user-not-found'].includes(e.code))return logout()}
      if(verified&&!u.emailVerified)return go('verify');
      if(verified){try{const t=await u.getIdTokenResult();if(!t.claims.email_verified)await u.getIdToken(true)}catch(e){}}  /* so security rules see the verified flag */
      if(onboarded){try{const s=await getDoc(doc(db,'users',u.uid));if(!s.exists()||!s.data().onboarded)return go('onboarding')}catch(e){console.warn(e)}}
      open=true;document.documentElement.classList.remove('guarding');resolve(u)});
  });
}
