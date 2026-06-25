import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, signInWithRedirect, getRedirectResult, GoogleAuthProvider, onAuthStateChanged, User } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, 'ai-studio-73e9ce7f-7347-4837-a758-ccae784691f2'); // CRITICAL
export const auth = getAuth(app);

const provider = new GoogleAuthProvider();
provider.addScope('https://www.googleapis.com/auth/drive');
provider.addScope('https://www.googleapis.com/auth/calendar');
provider.addScope('https://www.googleapis.com/auth/gmail.modify');

// Flag to indicate if we are in the middle of a sign-in flow.
let isSigningIn = false;
// Cache the access token in memory.
let cachedAccessToken: string | null = null;

// Initialize auth state listener. Call this on app load.
export const initAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void
) => {
  // Handle redirect result for mobile
  getRedirectResult(auth).then((result) => {
    if (result) {
      const workspaceDomain = localStorage.getItem('auth_workspace_domain');
      if (workspaceDomain) {
        const userEmail = result.user.email;
        if (!userEmail || !userEmail.endsWith(`@${workspaceDomain}`)) {
          auth.signOut();
          cachedAccessToken = null;
          console.error(`SSO Failed: Email must belong to the workspace domain @${workspaceDomain}`);
          return;
        }
      }
      const credential = GoogleAuthProvider.credentialFromResult(result);
      if (credential?.accessToken) {
        cachedAccessToken = credential.accessToken;
      }
    }
  }).catch((error) => {
    console.error('Redirect sign in error:', error);
  });

  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      if (cachedAccessToken) {
        if (onAuthSuccess) onAuthSuccess(user, cachedAccessToken);
      } else if (!isSigningIn) {
        cachedAccessToken = null;
        if (onAuthFailure) onAuthFailure();
      }
    } else {
      cachedAccessToken = null;
      if (onAuthFailure) onAuthFailure();
    }
  });
};

// Must be called from a button click or user interaction
export const googleSignIn = async (workspaceDomain?: string): Promise<{ user: User; accessToken: string } | null> => {
  try {
    isSigningIn = true;
    
    if (workspaceDomain) {
      provider.setCustomParameters({ hd: workspaceDomain });
    } else {
      provider.setCustomParameters({});
    }

    const result = await signInWithPopup(auth, provider);
    
    // Additional security: verify the domain actually matches if provided
    if (workspaceDomain) {
       const userEmail = result.user.email;
       if (!userEmail || !userEmail.endsWith(`@${workspaceDomain}`)) {
          await auth.signOut();
          cachedAccessToken = null;
          throw new Error(`SSO Failed: Email must belong to the workspace domain @${workspaceDomain}`);
       }
    }

    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Failed to get access token from Firebase Auth');
    }

    cachedAccessToken = credential.accessToken;
    return { user: result.user, accessToken: cachedAccessToken };
  } catch (error: any) {
    console.error('Sign in error:', error);
    throw error;
  } finally {
    isSigningIn = false;
  }
};

// For mobile, we must use redirect instead of popup
export const googleSignInRedirect = async (workspaceDomain?: string): Promise<void> => {
  try {
    isSigningIn = true;
    
    if (workspaceDomain) {
      provider.setCustomParameters({ hd: workspaceDomain });
      localStorage.setItem('auth_workspace_domain', workspaceDomain);
    } else {
      provider.setCustomParameters({});
      localStorage.removeItem('auth_workspace_domain');
    }

    await signInWithRedirect(auth, provider);
    // Page will reload, execution stops here.
  } catch (error: any) {
    console.error('Sign in redirect error:', error);
    isSigningIn = false;
    throw error;
  }
};

export const getAccessToken = async (): Promise<string | null> => {
  return cachedAccessToken;
};

export const logout = async () => {
  await auth.signOut();
  cachedAccessToken = null;
};
