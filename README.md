# Coffee Bond POS

## Coffee Bond POS MVP v1.6 — Live Menu Management Inventory System

- Menu Management is the active inventory/menu system.
- Uday Park can run live on Menu Management POS.
- Store-level source control remains available.
- Rollback remains technically available for safety.
- Old collections remain untouched only as backup, not as the primary workflow.

A Firebase-based Point of Sale (POS) system.

## Project Structure

- `frontend/` - React frontend (Vite, TailwindCSS)
- `firestore.rules` - Firebase Security Rules
- `firestore.indexes.json` - Firestore composite index definitions
- `firebase.json` - Firebase CLI deployment configuration
- `.firebaserc.example` - Example local Firebase project mapping

## 1. Install Dependencies

```bash
npm install
```

## 2. Environment Variables

Create a `.env` file based on `.env.example`:

```bash
cp .env.example .env
```

Add your Firebase configuration:
```
VITE_FIREBASE_API_KEY=""
VITE_FIREBASE_AUTH_DOMAIN=""
VITE_FIREBASE_PROJECT_ID=""
VITE_FIREBASE_MESSAGING_SENDER_ID=""
VITE_FIREBASE_APP_ID=""
```

Firebase Storage is configured in the app for `coffee-bond-pos.firebasestorage.app`.

## 3. Run the Application

```bash
npm run dev
```

## 4. Connect Firebase CLI Locally

Install and log in to the Firebase CLI if needed:

```bash
npm install -g firebase-tools
firebase login
```

Create a local `.firebaserc` file for your own Firebase project. Do not commit this file.

Recommended:

```bash
firebase use --add
```

Then select your Firebase project and use `default` as the alias.

Alternative manual setup:

```bash
cp .firebaserc.example .firebaserc
```

Then edit `.firebaserc` locally and replace `your-firebase-project-id` with your Firebase project ID.

The real `.firebaserc` and `.env` files are intentionally ignored by git because they contain project-specific configuration.

## 5. Deploy Firestore Rules and Indexes

`firebase.json` points the Firebase CLI to the local rules and indexes files:

- Rules: `firestore.rules`
- Indexes: `firestore.indexes.json`

Deploy Firestore security rules:

```bash
firebase deploy --only firestore:rules
```

Deploy Firestore indexes:

```bash
firebase deploy --only firestore:indexes
```

You can deploy both together with:

```bash
firebase deploy --only firestore
```

## 6. Seed the System

To start using the app, you need administrative privileges and initial data:
1. Log in with a standard email (e.g. `admin@coffeebond.com`) and any password. (Make sure you enable Email/Password authentication in Firebase).
2. Because it's the first login, your account doesn't have an admin profile. The app will direct you to a "Missing Profile" screen.
3. Click the **"Force Admin Setup"** button on this screen (available during testing/missing profile state) to bootstrap an Admin profile for yourself.
4. You will be redirected to the Admin dashboard.
5. Go to **Admin → Seed Data** and click **"1. Initialize System Roles & Categories"**, followed by **"2. Seed Basic Menu Items"** if you want sample Coffee Bond data.
6. The system is now fully set up.

## 7. Test Flow

1. Go to the **POS**. Select an initial store if prompted.
2. Add items to the cart and click checkout.
3. Once checkout completes, a receipt displays.
4. The system automatically creates KOT (Kitchen Order Ticket) items based on the menu item's prep station (Barista/Kitchen).
5. Open the **Barista KOT** or **Kitchen KOT** page in a new window to see the incoming orders.
6. Check **Reports** to see live stats update.

## 8. Troubleshooting Firebase Auth

If you encounter sign-in issues (like `auth/network-request-failed` or invalid API key), check the following:

- **Missing Authorized Domain**: If you get a "network request failed" or cross-origin error, you must add your current hostname (e.g., the web preview URL) to **Firebase Console → Authentication → Settings → Authorized domains**.
- **Email/Password Sign-in Not Enabled**: You must explicitly enable the "Email/Password" sign-in method in **Firebase Console → Authentication → Sign-in method**.
- **Wrong Firebase Env Values**: Make sure the values in your `.env` file perfectly match the values from Firebase Console → Project Settings → General → Your apps (Web app configuration). Missing or incorrect `VITE_FIREBASE_API_KEY` or `VITE_FIREBASE_AUTH_DOMAIN` will cause instant failures.

## 9. Required Firestore Indexes

The application requires specific composite indexes to query data efficiently. These are tracked in `firestore.indexes.json` and can be deployed with:

```bash
firebase deploy --only firestore:indexes
```

If an index is missing in Firebase, you may also see a UI warning guiding you to create it.

**Required Composite Index:**
Collection: `stockMovements`
- `storeId` (Ascending)
- `createdAt` (Descending)

## 10. Production Modes / Stock Examples

The new Menu Management architecture supports the following production modes:

- **Batch Prep:** Items produced in batches from raw ingredients and stored before sale.
  - *Example:* Cold Foam, Vanilla Sweet Cream, Aioli Dip, Cold Brew Concentrate.
- **Assembled to Order:** Items assembled at order time or near-service time from bought/prepped components.
  - *Example:* Bond Pizza (pizza base + sauce + cheese + toppings), Salad, Zaffle.
- **Bought & Sold:** Finished products purchased from supplier/bakery and sold directly.
  - *Example:* Protein bars, Ice cream, Retail coffee bags.
- **Made to Order:** Prepared directly from raw/prep components at order time.
  - *Example:* Latte, Cloud Black.
