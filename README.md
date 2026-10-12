# Grist IFClite Federation Widget

A Grist custom widget that loads IFC models from URL cells and displays them
in one federated IFClite scene.

## Configure in Grist

1. In the repository's **Settings → Pages**, set **Build and deployment →
   Source** to **GitHub Actions**. This one-time step is required to authorize
   the first deployment.
2. After the Pages workflow succeeds, the widget will be available at
   <https://aurizasalim.github.io/grist-ifc-widget4/>.
3. Add a **Custom** widget to the page and set its URL to the hosted
   `index.html`. In the widget's **Data** settings, select the `Models` table
   so table changes trigger a refresh. No columns need to be mapped.
4. Grant **Full document access**. The widget reads the `Models` table
   directly with `grist.docApi.fetchTable('Models')`; it does not read mapped
   column values. The table must have `Link`, `Name`, and `Show` columns.
5. Put one direct HTTP(S) IFC file URL in each row's `Link` cell. In Grist
   formulas, the Link column is referenced as `$Link`; the widget reads its
   column ID as `Link`. Only rows where `Show` is enabled are loaded. The
   model host must allow browser cross-origin requests from the widget. When
   the `Models` table changes, the widget refreshes the federation and clears
   the previous scene so disabled models are unloaded.

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
