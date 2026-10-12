# Grist IFClite Federation Widget

A Grist custom widget that loads IFC attachments from a table and displays them
in one federated IFClite scene.

## Configure in Grist

1. The widget is published at
   <https://aurizasalim.github.io/grist-ifc-widget4/> by the GitHub Pages
   workflow.
2. Add a **Custom** widget to a Grist page, select the table containing the
   models, and set the widget URL to the hosted `index.html`.
3. Grant **Read selected table** access and map the required **IFC model**
   field to an Attachments column. Optionally map **Model name** to a Text
   column.
4. Put one IFC file in each row's attachment cell. Rows with multiple attached
   IFCs are supported; every file is loaded as an individual model.

The widget fetches attachment data directly from the current Grist document's
attachment download endpoint using a read-only token. The token and file
contents are not sent to another service.

## Development

```sh
npm install
npm run dev
npm run build
```

The viewer requires a browser with WebGPU. Geometry is processed in the
browser's main thread so the Grist widget API can load without cross-origin
isolation headers.

Pushing to `main` automatically builds and publishes `dist/` to GitHub Pages.
