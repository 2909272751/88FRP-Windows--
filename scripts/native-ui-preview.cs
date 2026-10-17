using System;
using System.Windows;

// Separate test entry point; never included in the shipped executable.
internal static class NativeUiPreview
{
    [STAThread]
    private static void Main(string[] args)
    {
        DpiSupport.Enable();
        if (args.Length == 1) Program.ConsolePort = Int32.Parse(args[0]);
        else {
            if (!System.IO.File.Exists(Program.ServicePortsPath)) throw new ArgumentException("Expected isolated fixture port");
            Program.LoadConsolePort();
        }
        App app = new App();
        MainWindow window = new MainWindow(false);
        window.ContentRendered += delegate {
            System.IO.File.WriteAllText(System.IO.Path.Combine(Program.AppDataDir, "preview-window.txt"),
                window.IsVisible + " " + window.WindowState + " " + window.Left + "," + window.Top + " " + window.ActualWidth + "x" + window.ActualHeight);
            window.Dispatcher.BeginInvoke(System.Windows.Threading.DispatcherPriority.ApplicationIdle, new Action(delegate {
                var bitmap = new System.Windows.Media.Imaging.RenderTargetBitmap((int)window.ActualWidth, (int)window.ActualHeight, 96, 96, System.Windows.Media.PixelFormats.Pbgra32);
                var background = new System.Windows.Media.DrawingVisual();
                using (var drawing = background.RenderOpen()) drawing.DrawRectangle(window.Background, null, new Rect(0, 0, window.ActualWidth, window.ActualHeight));
                bitmap.Render(background);
                bitmap.Render((System.Windows.Media.Visual)window.Content);
                var encoder = new System.Windows.Media.Imaging.PngBitmapEncoder();
                encoder.Frames.Add(System.Windows.Media.Imaging.BitmapFrame.Create(bitmap));
                using (var file = System.IO.File.Create(System.IO.Path.Combine(Program.AppDataDir, "native-preview.png"))) encoder.Save(file);
            }));
        };
        app.Run(window);
    }
}
