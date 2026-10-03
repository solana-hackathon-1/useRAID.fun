# Publish the coming-soon page

The complete static site is in `sites/coming-soon/`. It uses local fonts and plain HTML/CSS. No build, JavaScript, database, secrets, or Next.js server is required. The full application is not part of this deployment.

## Preview

The page is not part of the Next.js app, so it is not served by `npm run dev`. Serve the folder directly:

```sh
npx serve sites/coming-soon
# or: python3 -m http.server -d sites/coming-soon 4000
```

## Connect GitHub to Cloudflare Pages

1. Commit and push `sites/coming-soon/` and this guide to your GitHub repository (`0xdushy4nt/useRAID.fun`). Include only the files you intend to publish; other app work may still be uncommitted.
2. In Cloudflare, open **Workers & Pages**, create a **Pages** project, and choose **Connect to Git**. If the screen starts with Workers, switch to Pages.
3. Authorize GitHub and select `useRAID.fun`.
4. Apply these settings:

   | Setting                | Value                                       |
   | ---------------------- | ------------------------------------------- |
   | Production branch      | `main` (or the branch containing this page) |
   | Framework preset       | `None`                                      |
   | Root directory         | `sites/coming-soon`                         |
   | Build command          | `exit 0`                                    |
   | Build output directory | `.`                                         |
   | Environment variable   | `SKIP_DEPENDENCY_INSTALL` = `1`             |

   The output directory is relative to the root directory. Do not choose the Next.js preset or `npm run build` for this page. Skipping dependency installation avoids installing the main app's packages.

5. Save and deploy. Open the generated `*.pages.dev` address and confirm the page appears.

> Moving from `public/coming-soon` to `sites/coming-soon` keeps the placeholder out of the application's static files. The Cloudflare Pages project must switch its **Root directory** to `sites/coming-soon` (and the build watch path to `sites/coming-soon/*`) at the same time as this change deploys, or the placeholder deploy breaks.

Future pushes to the production branch deploy automatically. Optionally limit build watch paths to `sites/coming-soon/*` in the project's build settings; these paths are relative to the repository root.

## Connect your domain

1. Open the Pages project → **Custom domains** → **Set up a domain**.
2. Enter `useRAID.fun` (or your preferred domain) and follow the DNS prompts.
3. For the root domain, add the domain to the same Cloudflare account and point its registrar nameservers to the two nameservers Cloudflare assigns. If already managed there, no nameserver change is needed. Preserve existing email and verification DNS records when moving DNS.
4. Cloudflare creates the Pages CNAME after you confirm. If an existing web record conflicts, replace only the record serving this hostname. This sends visitors to the coming-soon page.
5. Wait for the domain to show **Active**, then verify the HTTPS address. Cloudflare provisions the certificate.
6. Optional: add `www.useRAID.fun` as a second custom domain if you want it to work too.

For a subdomain with DNS hosted elsewhere, first associate it in Pages, then add a CNAME at that DNS provider pointing to the assigned `your-project.pages.dev` hostname. A DNS record alone does not register the domain with Pages.

No GitHub Pages configuration, GitHub Actions workflow, API keys, or app environment variables are needed. `SKIP_DEPENDENCY_INSTALL` above is only a build setting. No launch date, social account, or signup form needs configuring; the page intentionally makes no unconfirmed promises.

## Change the page or launch the app

Edit copy in `sites/coming-soon/index.html` and appearance in `sites/coming-soon/styles.css`, then push. Font licenses are included with the assets. When the full app is ready, deploy it with its server/database requirements and switch the domain to that deployment. These static Pages settings host only the placeholder.

Official references: [static HTML](https://developers.cloudflare.com/pages/framework-guides/deploy-anything/), [build settings](https://developers.cloudflare.com/pages/configuration/build-configuration/), [custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/).
