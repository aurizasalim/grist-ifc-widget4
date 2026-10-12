# Grist IFClite Federation Widget

A Grist custom widget that loads IFC attachments from a table and displays them
in one federated IFClite scene.

## Configure in Grist

1. In the repository's **Settings → Pages**, set **Build and deployment →
   Source** to **GitHub Actions**. This one-time step is required to authorize
   the first deployment.
2. After the Pages workflow succeeds, the widget will be available at
   <https://aurizasalim.github.io/grist-ifc-widget4/>.
3. Add a **Custom** widget to a Grist page, select the table containing the
   models, and set the widget URL to the hosted `index.html`.
4. Grant **Read selected table** access and map the **Link** field to the
   **Link** Text column and the **Name** field to the **Name** Text column.
5. Put one direct HTTP(S) IFC file URL in each row's Link cell. The target
   server must allow browser cross-origin requests from the widget.

The widget downloads models from the URLs in the Link column. It does not send
Grist access tokens to model hosts.

## Development

```sh
npm install
npm run dev
npm run build
```

The viewer requires a browser with WebGPU. Geometry is processed in the
browser's main thread so the Grist widget API can load without cross-origin
isolation headers.

Pushing to `main` automatically builds and publishes `dist/` to GitHub Pages
once Pages has been enabled for the repository. You can also trigger a
deployment from **Actions → Deploy to GitHub Pages → Run workflow**.
