using System.Collections.Generic;
using System.Windows;
using System.Windows.Data;
using System.Windows.Media;

// Bind colors rather than mutating brushes after WPF has sealed a style/template.
// The expression also keeps shared brushes live when used by template setters.
internal sealed class ClientThemePalette
{
    private readonly Dictionary<string, ThemeColor> colors = new Dictionary<string, ThemeColor>();
    public bool IsDark { get; private set; }

    public ClientThemePalette() { Apply(false); }

    public SolidColorBrush Brush(string name) { return colors[name].Brush; }

    public void Apply(bool dark)
    {
        Set("App", dark ? "#111827" : "#F6F8FB");
        Set("Card", dark ? "#1E293B" : "#FFFFFF");
        Set("Text", dark ? "#F1F5F9" : "#0F172A");
        Set("Muted", dark ? "#CBD5E1" : "#64748B");
        Set("Border", dark ? "#475569" : "#E2E8F0");
        Set("Accent", "#2563EB");
        Set("AccentText", dark ? "#93B4FF" : "#2563EB");
        Set("PrimarySoft", dark ? "#203353" : "#EEF4FF");
        Set("Success", dark ? "#5EEAD4" : "#0F806F");
        Set("Danger", dark ? "#FDA4AF" : "#C8363E");
        Set("Surface", dark ? "#273449" : "#F8FAFC");
        IsDark = dark;
    }

    private void Set(string name, string value)
    {
        ThemeColor color;
        if (!colors.TryGetValue(name, out color)) {
            color = new ThemeColor();
            colors.Add(name, color);
        }
        color.Value = (Color)ColorConverter.ConvertFromString(value);
    }
}

internal sealed class ThemeColor : DependencyObject
{
    public static readonly DependencyProperty ValueProperty = DependencyProperty.Register(
        "Value", typeof(Color), typeof(ThemeColor), new PropertyMetadata(Colors.Transparent));
    public Color Value {
        get { return (Color)GetValue(ValueProperty); }
        set { SetValue(ValueProperty, value); }
    }
    public SolidColorBrush Brush { get; private set; }
    public ThemeColor()
    {
        Brush = new SolidColorBrush();
        BindingOperations.SetBinding(Brush, SolidColorBrush.ColorProperty,
            new Binding("Value") { Source = this, Mode = BindingMode.OneWay });
    }
}
