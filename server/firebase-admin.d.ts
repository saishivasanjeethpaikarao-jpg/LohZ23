declare module "firebase-admin" {
  import { App } from "firebase-admin/app";

  export function initializeApp(options?: any): App;
  export function cert(serviceAccount: any): any;
  export function auth(app?: App): any;
  export function firestore(app?: App): any;
  export function getApp(): App;
  export function getApps(): App[];

  namespace credential {
    function cert(serviceAccount: any): any;
  }
}
